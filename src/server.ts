import { McpServer } from "@modelcontextprotocol/server";
import {
    serveStdio,
    StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { readonly, z } from "zod";

// Cache lifetime: 7 days
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type DiningLocation = {
    id: number;
    name: string;
    slug: string;
    address: string;
    wayfindingNote: string | null;
    operatingStatus: string;

    hours: Record<
        "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
        {
            enabled: boolean;
            start: string | null;
            end: string | null;
            is24Hours: boolean;
        }
    >;

    availableMeals: string[];
};

/**
 * Fetches raw Nutrislice payload and maps it to DiningLocation[].
 *
 * @param district_name Nutrislice district slug
 * @returns Array of dining locations, or null on failure
 */
async function getDiningLocations(
    district_name: string,
): Promise<DiningLocation[] | null> {
    try {
        const response = await fetch(
            `https://${district_name}.api.nutrislice.com/menu/api/schools`,
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        const locations: DiningLocation[] = [];
        const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

        for (const location of data) {
            locations.push({
                id: location.id,
                name: location.name,
                slug: location.slug,
                address: location.address,
                wayfindingNote: location.wayfinding_note || null,
                operatingStatus: location.operating_status,

                hours: Object.fromEntries(
                    days.map((day) => [
                        day,
                        {
                            enabled: location[`${day}_enabled`],
                            start: location[`${day}_start`],
                            end: location[`${day}_end`],
                            is24Hours: location[`${day}_is_24_hours`],
                        },
                    ]),
                ) as DiningLocation["hours"],

                availableMeals: location.active_menu_types.map(
                    (menu: { name: string }) => menu.name,
                ),
            });
        }

        return locations;
    } catch (error) {
        console.error("Error making request:", error);
        return null;
    }
}

// Server layer
function createServer(): McpServer {
    const server = new McpServer({
        name: "nutrislice-mcp-unofficial",
        version: "1.0.0",
        capabilities: {
            resources: {},
            tools: {},
            prompts: {},
        },
    });

    // In-memory caches, shared by tools in this server instance.
    const locationCache = new Map<number, DiningLocation>();

    const districtCache = new Map<
        string,
        {
            data: DiningLocation[];
            lastUpdatedAt: number;
        }
    >();

    // Prevent duplicate simultaneous API requests for the same district.
    const inFlight = new Map<string, Promise<DiningLocation[] | null>>();

    // Checks cached data without making an API request.
    server.registerTool(
        "check-cache",
        {
            title: "Check Dining Locations Cache",
            description:
                "Always check this cache before fetching dining locations. " +
                "Returns cached locations, freshness status, and last update time. " +
                "If missing or stale (7+ days), call get-locations to fetch fresh data. " +
                "If fresh, use cached data, tell the user when it was last updated, " +
                "mention that schedules may change, and offer an optional refresh. " +
                "Never fetch data through this tool.",

            inputSchema: z.object({
                district_name: z.string().min(1),
            }),

            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ district_name }) => {
            const cached = districtCache.get(district_name);

            const status = !cached
                ? "miss"
                : Date.now() - cached.lastUpdatedAt >= CACHE_TTL_MS
                  ? "stale"
                  : "fresh";

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            status,
                            lastUpdatedAt: cached
                                ? new Date(cached.lastUpdatedAt).toISOString()
                                : null,
                            locations: cached?.data ?? null,
                        }),
                    },
                ],
            };
        },
    );

    // Fetches fresh locations on cache miss, expiration, or user request.
    server.registerTool(
        "get-locations",
        {
            title: "Get Dining Locations",
            description:
                "Fetch fresh dining locations from Nutrislice and update the cache. " +
                "Call after check-cache returns miss or stale (7+ days), " +
                "or when the user explicitly requests updated data. " +
                "Avoid unnecessary API requests. Report the last update time " +
                "and tell the user when fresh data was retrieved.",

            inputSchema: z.object({
                district_name: z
                    .string()
                    .min(1)
                    .describe(
                        "Enter your District name (e.g., 'wsu' from wsu.nutrislice.edu)",
                    ),
            }),

            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ district_name }) => {
            let request = inFlight.get(district_name);

            if (!request) {
                request = getDiningLocations(district_name);
                inFlight.set(district_name, request);
            }

            try {
                const locations = await request;

                if (locations === null) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: "Failed to get dining locations",
                            },
                        ],
                        isError: true,
                    };
                }

                const lastUpdatedAt = Date.now();

                districtCache.set(district_name, {
                    data: locations,
                    lastUpdatedAt,
                });

                for (const location of locations) {
                    locationCache.set(location.id, location);
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                source: "api",
                                lastUpdatedAt: new Date(
                                    lastUpdatedAt,
                                ).toISOString(),
                                locations,
                            }),
                        },
                    ],
                };
            } finally {
                inFlight.delete(district_name);
            }
        },
    );

    return server;
}

async function main() {
    const transport = new StdioServerTransport();
    const server = createServer();

    await server.connect(transport);
}

main();

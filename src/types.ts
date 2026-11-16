export type RawDiningLocation = {
    id: number;
    name: string;
    slug: string;
    address: string;
    wayfinding_note?: string | null;
    operating_status: string;
    active_menu_types: { id: number; name: string; slug: string }[];
    mon_enabled: boolean;
    mon_start: string | null;
    mon_end: string | null;
    mon_is_24_hours: boolean;
    tue_enabled: boolean;
    tue_start: string | null;
    tue_end: string | null;
    tue_is_24_hours: boolean;
    wed_enabled: boolean;
    wed_start: string | null;
    wed_end: string | null;
    wed_is_24_hours: boolean;
    thu_enabled: boolean;
    thu_start: string | null;
    thu_end: string | null;
    thu_is_24_hours: boolean;
    fri_enabled: boolean;
    fri_start: string | null;
    fri_end: string | null;
    fri_is_24_hours: boolean;
    sat_enabled: boolean;
    sat_start: string | null;
    sat_end: string | null;
    sat_is_24_hours: boolean;
    sun_enabled: boolean;
    sun_start: string | null;
    sun_end: string | null;
    sun_is_24_hours: boolean;
};

export type DiningLocation = {
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
    availableMeals: { id: number; name: string; slug: string }[];
};

// Keep the full Nutrislice food record, including nutrition and metadata.
export type FoodInfo = {
    id: number;
    name: string;
    description: string;
    subtext: string;
    image_url: string | null;
    image_alt_text: string | null;
    hoverpic_url: string | null;
    price: number | null;
    ingredients: string | null;
    food_category: string;
    food_highlight_message: string | null;
    file_url: string;
    download_label: string;
    rounded_nutrition_info: {
        calories: number | null;
        g_fat: number | null;
        g_saturated_fat: number | null;
        g_trans_fat: number | null;
        mg_cholesterol: number | null;
        g_carbs: number | null;
        g_added_sugar: number | null;
        g_sugar: number | null;
        mg_potassium: number | null;
        mg_sodium: number | null;
        g_fiber: number | null;
        g_protein: number | null;
        mg_iron: number | null;
        mg_calcium: number | null;
        mg_vitamin_c: number | null;
        iu_vitamin_a: number | null;
        re_vitamin_a: number | null;
        mcg_vitamin_a: number | null;
        mg_vitamin_d: number | null;
        mcg_vitamin_d: number | null;
    } | null;
    serving_size_info: {
        serving_size_amount: string;
        serving_size_unit: string;
    } | null;
    has_nutrition_info: boolean;
    icons: {
        food_icons: {
            id: number;
            synced_name: string;
            enabled: boolean;
            spotlight_enabled: boolean;
            sprite: {
                slug: string;
                name: string;
                help_text: string;
                class_name: string;
            } | null;
            custom_icon_url: string | null;
            custom_icon: number | null;
            custom_spotlight_icon_url: string | null;
            custom_spotlight_icon: number | null;
            type: number;
            behavior: number;
            is_filter: boolean;
            is_highlight: boolean;
            is_digital_signage_only: boolean;
            slug: string;
            icon_slug: string | null;
            spotlight_icon_slug: string | null;
            name: string;
            _synced_name: string;
            help_text: string;
            sort_order: number;
            _enabled: boolean;
            food_icon_group: number;
        }[];
        myplate_icons: unknown[];
    };
    icons_approved: boolean;
    nested_foods: unknown[];
    aggregated_data: {
        price_adjustment: number;
        icons_approved: boolean;
        food_icons: unknown[];
        calories: number;
    };
    food_sizes: unknown[];
    ds_calories_override: string;
    synced_id: string | null;
    sync_placeholder: unknown;
    has_options_or_sides: boolean;
    digest: string;
    pos_item_id: string;
    smart_recipe_id: number | null;
    has_subfoods: boolean;
    meal_plan_price: number | null;
    use_custom_sizes: boolean;
    tags: number[];
    synced_ordering_enabled: boolean;
    ordering_enabled: boolean;
    ordering_enabled_unlocked: boolean;
};

export type WeeklyMenu = {
    startDate: string;
    menuTypeId: number;
    sourceUpdatedAt: string | null;
    days: {
        date: string;
        unpublished: boolean;
        stations: {
            name: string;
            items: FoodInfo[];
        }[];
    }[];
};

export type RawWeeklyMenu = {
    start_date: string;
    menu_type_id: string | number;
    last_updated?: string | null;
    days: {
        date: string;
        has_unpublished_menus: boolean;
        menu_items: {
            station_id: number | null;
            is_station_header: boolean;
            text: string;
            price: number | null;
            food: FoodInfo | null;
        }[];
    }[];
};

export type CacheEntry<T> = {
    data: T;
    lastUpdatedAt: number;
};

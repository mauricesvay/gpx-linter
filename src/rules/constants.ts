/** Central map of every built-in rule's parameter defaults. */
export const RULE_DEFAULTS: Record<string, Record<string, unknown>> = {
	max_slope: {
		max_slope_percentage: 10,
		min_segment_meters: 3,
		min_elevation_delta_meters: 1.5,
	},
	roadworks: { buffer_meters: 1, geojson_file: "" },
	sharp_turn: {
		max_angle: 60,
		min_segment_meters: 5,
		min_heading_change_degrees: 0,
	},
	off_road: { max_distance_meters: 50 },
	missing_elevation: { max_missing_elevation_percentage: 50 },
	route_gaps: { max_gap_meters: 500 },
	loop_closure: { max_return_distance_meters: 100 },
	bike_lane_no_same_direction_car_lane: { max_distance_meters: 30 },
};

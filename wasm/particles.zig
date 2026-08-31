const std = @import("std");

const max_node_count: usize = 1024;
const vector_width: usize = 3;
const edge_width: usize = vector_width * 2;
const max_edge_count: usize = max_node_count * 2;
const edge_component_count: usize = max_edge_count * edge_width;
const relay_edge_seen_count: usize = max_node_count * max_node_count;
// Keep the numeric world larger than the camera envelope. High-latency peers
// are allowed to leave the viewport instead of being pulled into a ring that
// falsely suggests a short path.
const boundary_radius: f32 = 2_048.0;
const repulsion_radius: f32 = 7.5;
const connected_status: i32 = 1;
const kubo_source: i32 = 1;
const no_relay: i32 = -1;
const edge_red: f32 = 0.6235294;
const edge_green: f32 = 1.0;
const edge_blue: f32 = 0.8901961;

var positions: [max_node_count * vector_width]f32 = [_]f32{0} ** (max_node_count * vector_width);
var anchors: [max_node_count * vector_width]f32 = [_]f32{0} ** (max_node_count * vector_width);
var velocities: [max_node_count * vector_width]f32 = [_]f32{0} ** (max_node_count * vector_width);
var peer_status: [max_node_count]i32 = [_]i32{0} ** max_node_count;
var peer_latency: [max_node_count]f32 = [_]f32{-1.0} ** max_node_count;
var peer_relay_index: [max_node_count]i32 = [_]i32{no_relay} ** max_node_count;
var peer_source: [max_node_count]i32 = [_]i32{0} ** max_node_count;
var edge_positions: [edge_component_count]f32 = [_]f32{0} ** edge_component_count;
var edge_colors: [edge_component_count]f32 = [_]f32{0} ** edge_component_count;
var relay_edges_seen: [relay_edge_seen_count]bool = [_]bool{false} ** relay_edge_seen_count;
var active_count: usize = 0;
var rendered_edge_count: usize = 0;

export fn max_nodes() i32 {
    return @intCast(max_node_count);
}

export fn init_system(requested_count: i32) void {
    active_count = clampedCount(requested_count);
    @memset(positions[0..], 0);
    @memset(anchors[0..], 0);
    @memset(velocities[0..], 0);
    @memset(peer_status[0..], 0);
    @memset(peer_latency[0..], -1.0);
    @memset(peer_relay_index[0..], no_relay);
    @memset(peer_source[0..], 0);
    @memset(edge_positions[0..], 0);
    @memset(edge_colors[0..], 0);
    @memset(relay_edges_seen[0..], false);
    rendered_edge_count = 0;
}

export fn seed_node(requested_index: i32, requested_seed: i32, requested_radius: f32, requested_sector: i32) void {
    if (requested_index < 0) return;

    const index: usize = @intCast(requested_index);
    if (index >= active_count or index >= max_node_count) return;

    const seed: u32 = @bitCast(requested_seed);
    const indexed_seed = seed +% (@as(u32, @intCast(index)) *% 0x9e3779b9);
    const radius = if (std.math.isFinite(requested_radius)) std.math.clamp(requested_radius, 8.0, 2048.0) else 40.0;
    // A uniform sphere keeps arrivals visually distributed in every direction.
    // The transport sector is metadata, not a fake topology signal.
    _ = requested_sector;
    const theta = unitFloat(indexed_seed +% 0x68bc21eb) * (2.0 * std.math.pi);
    const cosine_phi = unitFloat(indexed_seed +% 0x02e5be93) * 2.0 - 1.0;
    const sine_phi = @sqrt(@max(0.0, 1.0 - cosine_phi * cosine_phi));
    const offset = index * vector_width;

    positions[offset] = radius * sine_phi * @cos(theta);
    positions[offset + 1] = radius * cosine_phi;
    positions[offset + 2] = radius * sine_phi * @sin(theta);
    anchors[offset] = positions[offset];
    anchors[offset + 1] = positions[offset + 1];
    anchors[offset + 2] = positions[offset + 2];

    const orbital_speed = 0.04 + unitFloat(indexed_seed +% 0x967a889b) * 0.06;
    velocities[offset] = -@sin(theta) * orbital_speed;
    velocities[offset + 1] = (unitFloat(indexed_seed +% 0x4f1bbcdc) - 0.5) * 0.08;
    velocities[offset + 2] = @cos(theta) * orbital_speed;
}

export fn step(delta_seconds: f32, requested_count: i32, motion_scale: f32) void {
    if (!std.math.isFinite(delta_seconds) or !std.math.isFinite(motion_scale)) return;

    const count = @min(active_count, clampedCount(requested_count));
    const scale = std.math.clamp(motion_scale, 0.0, 1.0);
    const delta = std.math.clamp(delta_seconds, 0.0, 0.05) * scale;
    if (count == 0 or delta == 0.0) return;

    var index: usize = 0;
    while (index < count) : (index += 1) {
        const offset = index * vector_width;
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];

        var acceleration_x = (anchors[offset] - x) * 0.08 - z * 0.0015;
        var acceleration_y = (anchors[offset + 1] - y) * 0.1;
        var acceleration_z = (anchors[offset + 2] - z) * 0.08 + x * 0.0015;

        var other_index: usize = 0;
        while (other_index < count) : (other_index += 1) {
            if (other_index == index) continue;

            const other_offset = other_index * vector_width;
            const dx = x - positions[other_offset];
            const dy = y - positions[other_offset + 1];
            const dz = z - positions[other_offset + 2];
            const distance_squared = dx * dx + dy * dy + dz * dz;
            const radius_squared = repulsion_radius * repulsion_radius;

            if (distance_squared > 0.0001 and distance_squared < radius_squared) {
                const distance = @sqrt(distance_squared);
                const strength = (1.0 - distance / repulsion_radius) * 1.35;
                const inverse_distance = 1.0 / distance;
                acceleration_x += dx * inverse_distance * strength;
                acceleration_y += dy * inverse_distance * strength;
                acceleration_z += dz * inverse_distance * strength;
            }
        }

        const distance_from_center = @sqrt(x * x + y * y + z * z);
        if (distance_from_center > boundary_radius) {
            const inverse_distance = 1.0 / distance_from_center;
            const boundary_force = (distance_from_center - boundary_radius) * 0.18;
            acceleration_x -= x * inverse_distance * boundary_force;
            acceleration_y -= y * inverse_distance * boundary_force;
            acceleration_z -= z * inverse_distance * boundary_force;
        }

        const damping = 1.0 - @min(delta * 1.8, 0.08);
        velocities[offset] = (velocities[offset] + acceleration_x * delta) * damping;
        velocities[offset + 1] = (velocities[offset + 1] + acceleration_y * delta) * damping;
        velocities[offset + 2] = (velocities[offset + 2] + acceleration_z * delta) * damping;

        positions[offset] += velocities[offset] * delta;
        positions[offset + 1] += velocities[offset + 1] * delta;
        positions[offset + 2] += velocities[offset + 2] * delta;
    }
}

export fn positions_ptr() [*]f32 {
    return positions[0..].ptr;
}

/// Store the small amount of peer metadata needed by the edge-layout kernel.
/// TypeScript owns identity and text; this module owns the numeric line data.
export fn set_peer_metadata(
    requested_index: i32,
    status: i32,
    latency_ms: f32,
    requested_relay_index: i32,
) void {
    if (requested_index < 0) return;
    const index: usize = @intCast(requested_index);
    if (index >= active_count or index >= max_node_count) return;

    peer_status[index] = status;
    peer_latency[index] = if (std.math.isFinite(latency_ms) and latency_ms >= 0.0)
        latency_ms
    else
        -1.0;
    peer_relay_index[index] = if (requested_relay_index >= 0 and requested_relay_index < @as(i32, @intCast(active_count)))
        requested_relay_index
    else
        no_relay;
}

/// Mark whether a connected record came from the browser node or the
/// separately imported local Kubo daemon. This keeps Kubo out of center lines
/// while still allowing evidence-backed Kubo relay edges.
export fn set_peer_source(requested_index: i32, source: i32) void {
    if (requested_index < 0) return;
    const index: usize = @intCast(requested_index);
    if (index >= active_count or index >= max_node_count) return;
    peer_source[index] = if (source == kubo_source) kubo_source else 0;
}

/// Build all evidence-backed line segments from the current WASM positions.
/// The first endpoint of a center edge is the surface of the local browser
/// core. Relay edges are emitted once, only when both endpoint records are present.
export fn layout_edges(requested_count: i32) void {
    const count = @min(active_count, clampedCount(requested_count));
    rendered_edge_count = 0;
    @memset(relay_edges_seen[0..], false);

    var index: usize = 0;
    while (index < count) : (index += 1) {
        if (peer_status[index] != connected_status or peer_source[index] == kubo_source) continue;
        const offset = index * vector_width;
        const distance = @sqrt(
            positions[offset] * positions[offset] +
                positions[offset + 1] * positions[offset + 1] +
                positions[offset + 2] * positions[offset + 2],
        );
        const surface_scale = if (distance > 3.2) 3.2 / distance else 0.0;
        write_edge(
            positions[offset] * surface_scale,
            positions[offset + 1] * surface_scale,
            positions[offset + 2] * surface_scale,
            positions[offset],
            positions[offset + 1],
            positions[offset + 2],
            edge_brightness(peer_latency[index]),
        );
    }

    var target: usize = 0;
    while (target < count) : (target += 1) {
        if (peer_status[target] != connected_status) continue;
        const relay = peer_relay_index[target];
        if (relay < 0) continue;
        const relay_index: usize = @intCast(relay);
        if (relay_index >= count or relay_index == target) continue;
        const first = @min(relay_index, target);
        const second = @max(relay_index, target);
        const seen_index = first * max_node_count + second;
        if (relay_edges_seen[seen_index]) continue;
        relay_edges_seen[seen_index] = true;

        const relay_offset = relay_index * vector_width;
        const target_offset = target * vector_width;
        write_edge(
            positions[relay_offset],
            positions[relay_offset + 1],
            positions[relay_offset + 2],
            positions[target_offset],
            positions[target_offset + 1],
            positions[target_offset + 2],
            @min(0.72, edge_brightness(peer_latency[target])),
        );
    }
}

export fn edge_count() i32 {
    return @intCast(rendered_edge_count);
}

export fn edge_positions_ptr() [*]f32 {
    return edge_positions[0..].ptr;
}

export fn edge_colors_ptr() [*]f32 {
    return edge_colors[0..].ptr;
}

fn write_edge(
    start_x: f32,
    start_y: f32,
    start_z: f32,
    end_x: f32,
    end_y: f32,
    end_z: f32,
    brightness: f32,
) void {
    if (rendered_edge_count >= max_edge_count) return;
    const offset = rendered_edge_count * edge_width;
    edge_positions[offset] = start_x;
    edge_positions[offset + 1] = start_y;
    edge_positions[offset + 2] = start_z;
    edge_positions[offset + 3] = end_x;
    edge_positions[offset + 4] = end_y;
    edge_positions[offset + 5] = end_z;

    const safe_brightness = std.math.clamp(brightness, 0.0, 1.5);
    edge_colors[offset] = edge_red * safe_brightness;
    edge_colors[offset + 1] = edge_green * safe_brightness;
    edge_colors[offset + 2] = edge_blue * safe_brightness;
    edge_colors[offset + 3] = edge_red * safe_brightness;
    edge_colors[offset + 4] = edge_green * safe_brightness;
    edge_colors[offset + 5] = edge_blue * safe_brightness;
    rendered_edge_count += 1;
}

fn edge_brightness(latency_ms: f32) f32 {
    if (!std.math.isFinite(latency_ms) or latency_ms < 0.0) return 0.42;
    const normalized = std.math.clamp(latency_ms, 0.0, 800.0) / 800.0;
    return 1.15 - normalized * 0.57;
}

fn clampedCount(requested_count: i32) usize {
    if (requested_count <= 0) return 0;
    return @min(@as(usize, @intCast(requested_count)), max_node_count);
}

fn unitFloat(seed: u32) f32 {
    const sample = mix(seed) & 0x00ffffff;
    return @as(f32, @floatFromInt(sample)) / 16777215.0;
}

fn mix(seed: u32) u32 {
    var value = seed;
    value ^= value >> 16;
    value *%= 0x7feb352d;
    value ^= value >> 15;
    value *%= 0x846ca68b;
    value ^= value >> 16;
    return value;
}

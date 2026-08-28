const std = @import("std");

const max_node_count: usize = 512;
const vector_width: usize = 3;
const boundary_radius: f32 = 52.0;
const repulsion_radius: f32 = 7.5;

var positions: [max_node_count * vector_width]f32 = [_]f32{0} ** (max_node_count * vector_width);
var anchors: [max_node_count * vector_width]f32 = [_]f32{0} ** (max_node_count * vector_width);
var velocities: [max_node_count * vector_width]f32 = [_]f32{0} ** (max_node_count * vector_width);
var active_count: usize = 0;

export fn max_nodes() i32 {
    return @intCast(max_node_count);
}

export fn init_system(requested_count: i32) void {
    active_count = clampedCount(requested_count);
    @memset(positions[0..], 0);
    @memset(anchors[0..], 0);
    @memset(velocities[0..], 0);
}

export fn seed_node(requested_index: i32, requested_seed: i32, requested_radius: f32, requested_sector: i32) void {
    if (requested_index < 0) return;

    const index: usize = @intCast(requested_index);
    if (index >= active_count or index >= max_node_count) return;

    const seed: u32 = @bitCast(requested_seed);
    const indexed_seed = seed +% (@as(u32, @intCast(index)) *% 0x9e3779b9);
    const radius = if (std.math.isFinite(requested_radius)) std.math.clamp(requested_radius, 8.0, 44.0) else 40.0;
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

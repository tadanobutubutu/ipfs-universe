const std = @import("std");

// Static buffers for particles (max 2000 nodes for safety)
var positions: [6000]f32 = undefined;
var speeds: [2000]f32 = undefined;
var particle_count: usize = 0;

export fn init_system(count: usize) void {
    particle_count = count;
}

export fn set_particle_data(index: usize, x: f32, y: f32, z: f32, speed: f32) void {
    if (index < 2000) {
        positions[index * 3] = x;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = z;
        speeds[index] = speed;
    }
}

export fn update_particles(limit: f32) void {
    var i: usize = 0;
    while (i < particle_count) : (i += 1) {
        positions[i * 3 + 1] += speeds[i];
        if (positions[i * 3 + 1] > limit or positions[i * 3 + 1] < -limit) {
            speeds[i] *= -1.0;
        }
    }
}

export fn get_positions_ptr() [*]f32 {
    return &positions;
}

pub fn main() void {}

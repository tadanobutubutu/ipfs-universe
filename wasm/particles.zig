const std = @import("std");

// Static buffers for particles (max 2000 nodes for safety)
var positions: [6000]f32 = undefined;
var velocities: [6000]f32 = undefined;
var speeds: [2000]f32 = undefined;
var particle_count: usize = 0;
var frame_count: u32 = 0;
var start_time: i64 = 0;

export fn init_system(count: usize) void {
    particle_count = count;
    frame_count = 0;
    // We could use a timestamp here if we had an import, but we'll manage it from JS
}

export fn set_particle_data(index: usize, x: f32, y: f32, z: f32, speed: f32) void {
    if (index < 2000) {
        positions[index * 3] = x;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = z;
        velocities[index * 3] = 0;
        velocities[index * 3 + 1] = 0;
        velocities[index * 3 + 2] = 0;
        speeds[index] = speed;
    }
}

// Quantum Turbulence + Orbit Physics
export fn update_particles(radius: f32, delta: f32) void {
    var i: usize = 0;
    frame_count += 1;
    const dt = delta * 0.01;
    
    while (i < particle_count) : (i += 1) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        
        // 1. Attraction to core (Center: 0,0,0)
        const dist_sq = x*x + y*y + z*z;
        const dist = @sqrt(dist_sq);
        
        if (dist > 0.1) {
            const force = (0.5 / dist_sq) * dt;
            velocities[i * 3] -= (x / dist) * force;
            velocities[i * 3 + 1] -= (y / dist) * force;
            velocities[i * 3 + 2] -= (z / dist) * force;
        }
        
        // 2. Quantum Turbulence (Perlin-ish noise approximation)
        const t = @as(f32, @floatFromInt(frame_count)) * 0.01;
        velocities[i * 3] += @sin(y * 0.05 + t) * 0.01;
        velocities[i * 3 + 1] += @cos(z * 0.05 + t) * 0.01;
        velocities[i * 3 + 2] += @sin(x * 0.05 + t) * 0.01;
        
        // Apply velocity
        positions[i * 3] += velocities[i * 3];
        positions[i * 3 + 1] += velocities[i * 3 + 1];
        positions[i * 3 + 2] += velocities[i * 3 + 2];
        
        // Bounce off invisible boundaries
        if (dist > radius) {
            velocities[i * 3] *= -0.8;
            velocities[i * 3 + 1] *= -0.8;
            velocities[i * 3 + 2] *= -0.8;
        }
        
        // Dampening
        velocities[i * 3] *= 0.99;
        velocities[i * 3 + 1] *= 0.99;
        velocities[i * 3 + 2] *= 0.99;
    }
}

export fn get_positions_ptr() [*]f32 {
    return &positions;
}

export fn get_frame_count() u32 {
    return frame_count;
}

pub fn main() void {}

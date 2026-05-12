use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct ParticleSystem {
    positions: Vec<f32>,
    speeds: Vec<f32>,
}

#[wasm_bindgen]
impl ParticleSystem {
    #[wasm_bindgen(constructor)]
    pub fn new(count: usize) -> Self {
        let mut positions = Vec::with_capacity(count * 3);
        let mut speeds = Vec::with_capacity(count);
        
        for _ in 0..count {
            // Initial positions are handled by Three.js usually, 
            // but we store them here for processing
            positions.push(0.0);
            positions.push(0.0);
            positions.push(0.0);
            speeds.push(0.0);
        }
        
        ParticleSystem { positions, speeds }
    }

    pub fn set_particle(&mut self, index: usize, x: f32, y: f32, z: f32, speed: f32) {
        if index < self.speeds.len() {
            self.positions[index * 3] = x;
            self.positions[index * 3 + 1] = y;
            self.positions[index * 3 + 2] = z;
            self.speeds[index] = speed;
        }
    }

    pub fn update(&mut self, limit: f32) {
        for i in 0..self.speeds.len() {
            self.positions[i * 3 + 1] += self.speeds[i];
            if self.positions[i * 3 + 1].abs() > limit {
                self.speeds[i] *= -1.0;
            }
        }
    }

    pub fn get_positions(&self) -> *const f32 {
        self.positions.as_ptr()
    }
}

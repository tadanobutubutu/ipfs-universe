#![no_std]

use core::panic::PanicInfo;

const MAX_NODES: usize = 512;
const INPUT_STRIDE: usize = 2;
const RESULT_LEN: usize = 9;
const STATUS_CONNECTED: f32 = 1.0;
const STATUS_DISCONNECTED: f32 = 2.0;

static mut INPUT: [f32; MAX_NODES * INPUT_STRIDE] = [-1.0; MAX_NODES * INPUT_STRIDE];
static mut RESULT: [f32; RESULT_LEN] = [0.0; RESULT_LEN];

#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn max_nodes() -> i32 {
    MAX_NODES as i32
}

#[no_mangle]
pub extern "C" fn input_stride() -> i32 {
    INPUT_STRIDE as i32
}

#[no_mangle]
pub extern "C" fn result_len() -> i32 {
    RESULT_LEN as i32
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(INPUT).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const f32 {
    core::ptr::addr_of!(RESULT).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn analyze(requested_count: i32) {
    let count = if requested_count <= 0 {
        0
    } else {
        (requested_count as usize).min(MAX_NODES)
    };

    let mut connected = 0usize;
    let mut discovered = 0usize;
    let mut disconnected = 0usize;
    let mut latency_count = 0usize;
    let mut latencies = [0.0f32; MAX_NODES];

    unsafe {
        let input = core::slice::from_raw_parts(
            core::ptr::addr_of!(INPUT).cast::<f32>(),
            MAX_NODES * INPUT_STRIDE,
        );

        for index in 0..count {
            let status = input[index * INPUT_STRIDE];
            if status == STATUS_CONNECTED {
                connected += 1;
                let latency = input[index * INPUT_STRIDE + 1];
                if latency.is_finite() && latency >= 0.0 {
                    latencies[latency_count] = latency;
                    latency_count += 1;
                }
            } else if status == STATUS_DISCONNECTED {
                disconnected += 1;
            } else {
                discovered += 1;
            }
        }
    }

    insertion_sort(&mut latencies[..latency_count]);
    let p50 = nearest_rank(&latencies[..latency_count], 50);
    let p95 = nearest_rank(&latencies[..latency_count], 95);
    let jitter = if latency_count == 0 { 0.0 } else { p95 - p50 };
    let measurement_coverage = if connected == 0 {
        0.0
    } else {
        latency_count as f32 / connected as f32 * 100.0
    };

    unsafe {
        let result = core::slice::from_raw_parts_mut(
            core::ptr::addr_of_mut!(RESULT).cast::<f32>(),
            RESULT_LEN,
        );
        result.copy_from_slice(&[
            count as f32,
            connected as f32,
            discovered as f32,
            disconnected as f32,
            latency_count as f32,
            p50,
            p95,
            jitter,
            measurement_coverage,
        ]);
    }
}

fn insertion_sort(values: &mut [f32]) {
    for index in 1..values.len() {
        let value = values[index];
        let mut cursor = index;
        while cursor > 0 && values[cursor - 1] > value {
            values[cursor] = values[cursor - 1];
            cursor -= 1;
        }
        values[cursor] = value;
    }
}

fn nearest_rank(sorted: &[f32], percentile: usize) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }

    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

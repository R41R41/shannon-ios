#ifndef SHANNON_VOICE_DSP_H
#define SHANNON_VOICE_DSP_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  int32_t input_latency_samples;
  int32_t output_latency_samples;
} ShannonVoiceDSPLatency;

/// Processes a complete, interleaved Float32 buffer with independent pitch and
/// formant controls. Input and output must contain frame_count * channel_count
/// samples. Returns false when the buffer is too short or arguments are invalid.
bool shannon_voice_dsp_process(
    const float *input,
    int32_t frame_count,
    int32_t channel_count,
    double sample_rate,
    float pitch_semitones,
    float formant_semitones,
    float *output,
    ShannonVoiceDSPLatency *latency);

#ifdef __cplusplus
}
#endif

#endif

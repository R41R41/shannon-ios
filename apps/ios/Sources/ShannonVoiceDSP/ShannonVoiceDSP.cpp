#include "ShannonVoiceDSP.h"

#include "signalsmith-stretch/signalsmith-stretch.h"

#include <algorithm>
#include <cmath>
#include <vector>

bool shannon_voice_dsp_process(
    const float *input,
    int32_t frame_count,
    int32_t channel_count,
    double sample_rate,
    float pitch_semitones,
    float formant_semitones,
    float *output,
    ShannonVoiceDSPLatency *latency) {
  if (input == nullptr || output == nullptr || frame_count <= 0 ||
      channel_count <= 0 || channel_count > 2 || sample_rate <= 0) {
    return false;
  }

  signalsmith::stretch::SignalsmithStretch<float> stretch(0);
  stretch.presetCheaper(channel_count, sample_rate, false);
  stretch.setTransposeSemitones(pitch_semitones, 8000.0 / sample_rate);
  stretch.setFormantSemitones(formant_semitones, false);
  stretch.setFormantBase(200.0 / sample_rate);

  if (latency != nullptr) {
    latency->input_latency_samples = stretch.inputLatency();
    latency->output_latency_samples = stretch.outputLatency();
  }

  std::vector<std::vector<float>> input_channels(
      channel_count, std::vector<float>(frame_count));
  std::vector<std::vector<float>> output_channels(
      channel_count, std::vector<float>(frame_count));
  std::vector<float *> input_pointers(channel_count);
  std::vector<float *> output_pointers(channel_count);

  for (int32_t channel = 0; channel < channel_count; ++channel) {
    input_pointers[channel] = input_channels[channel].data();
    output_pointers[channel] = output_channels[channel].data();
    for (int32_t frame = 0; frame < frame_count; ++frame) {
      input_channels[channel][frame] =
          input[frame * channel_count + channel];
    }
  }

  const bool succeeded = stretch.exact(
      input_pointers.data(), frame_count, output_pointers.data(), frame_count);
  if (!succeeded) {
    std::fill(output, output + frame_count * channel_count, 0.0f);
    return false;
  }

  for (int32_t frame = 0; frame < frame_count; ++frame) {
    for (int32_t channel = 0; channel < channel_count; ++channel) {
      output[frame * channel_count + channel] =
          output_channels[channel][frame];
    }
  }
  return true;
}

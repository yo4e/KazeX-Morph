/* One independent WebAssembly instance per movie, owned by its worker. */
#include <stdint.h>
#include <stdlib.h>

static int fps;

/* ISO 14496-10 Annex A. Minimum level for this frame rate and image size;
 * the encoder separately checks frame size and decoded picture buffer size. */
static int throughput_level(int macroblocks) {
    static const int limits[][2] = {
        {1485, 10}, {3000, 11}, {6000, 12}, {11880, 13}, {19800, 21},
        {20250, 22}, {40500, 30}, {108000, 31}, {216000, 32},
        {245760, 40}, {522240, 42}, {589824, 50}, {983040, 51}
    };
    int rate = macroblocks * fps;
    for (unsigned i = 0; i < sizeof(limits) / sizeof(limits[0]); i++) {
        if (rate <= limits[i][0]) return limits[i][1];
    }
    return 52;
}

#define H264E_SVC_API 0
#define H264E_MAX_THREADS 0
#define MINIH264_IMPLEMENTATION
#include "minih264e.h"
#define MINIMP4_IMPLEMENTATION
#include "minimp4.h"

__attribute__((import_module("env"), import_name("write")))
extern int write_bytes(unsigned offset, const void *data, unsigned size);

static int output(int64_t offset, const void *data, size_t size, void *unused) {
    (void)unused;
    if (offset < 0 || (uint64_t)offset + size > UINT32_MAX) return -1;
    return write_bytes((unsigned)offset, data, size);
}

static H264E_persist_t *codec;
static H264E_scratch_t *scratch;
static H264E_io_yuv_t yuv;
static mp4_h26x_writer_t video;
static MP4E_mux_t *mux;
static uint8_t *rgba;
static int width, height;

__attribute__((export_name("begin")))
uint8_t *begin(int w, int h, int rate) {
    if (w < 2 || h < 2 || w > 1920 || h > 1920 || ((w | h) & 1) ||
        rate < 1 || rate > 60 || 90000 % rate) return NULL;
    width = w;
    height = h;
    fps = rate;
    H264E_create_param_t settings = {0};
    settings.width = width;
    settings.height = height;
    settings.gop = 2 * fps;
    settings.const_input_flag = 1; /* Accept even sizes not divisible by 16. */
    int context_bytes, scratch_bytes;
    if (H264E_sizeof(&settings, &context_bytes, &scratch_bytes)) return NULL;
    codec = malloc(context_bytes);
    scratch = malloc(scratch_bytes);
    unsigned pixels = width * height;
    rgba = malloc(4 * pixels);
    uint8_t *planes = malloc(pixels + pixels / 2);
    if (!codec || !scratch || !planes || !rgba || H264E_init(codec, &settings)) return NULL;
    yuv.yuv[0] = planes;
    yuv.yuv[1] = planes + pixels;
    yuv.yuv[2] = planes + pixels + pixels / 4;
    yuv.stride[0] = width;
    yuv.stride[1] = yuv.stride[2] = width / 2;
    mux = MP4E_open(0, 0, NULL, output);
    if (!mux || mp4_h26x_write_init(&video, mux, w, h, 0)) return NULL;
    return rgba;
}

/* The source is sRGB. Use studio-range BT.709 Y'CbCr; average all four
 * pixels for each chroma sample. The SPS describes matrix, range and TRC. */
static void convert_rgba(void) {
    for (int y = 0; y < height; y += 2) {
        for (int x = 0; x < width; x += 2) {
            int red = 0, green = 0, blue = 0;
            for (int j = 0; j < 2; j++) {
                for (int i = 0; i < 2; i++) {
                    unsigned at = (y + j) * width + x + i;
                    const uint8_t *p = rgba + 4 * at;
                    red += p[0];
                    green += p[1];
                    blue += p[2];
                    yuv.yuv[0][at] = 16 + ((2991 * p[0] + 10064 * p[1] + 1016 * p[2] + 8192) >> 14);
                }
            }
            unsigned at = (y / 2) * (width / 2) + x / 2;
            yuv.yuv[1][at] = 128 + ((-1649 * red - 5547 * green + 7196 * blue + 32768) >> 16);
            yuv.yuv[2][at] = 128 + ((7196 * red - 6536 * green - 660 * blue + 32768) >> 16);
        }
    }
}

__attribute__((export_name("add")))
int add(void) {
    convert_rgba();
    H264E_run_param_t params = {0};
    params.encode_speed = H264E_SPEED_BALANCED;
    params.qp_min = params.qp_max = 20;
    unsigned char *data;
    int size;
    int result = H264E_encode(codec, scratch, &params, &yuv, &data, &size);
    if (result || size <= 0) return -1;
    return mp4_h26x_write_nal(&video, data, size, 90000 / fps);
}

__attribute__((export_name("finish")))
int finish(void) {
    int status = MP4E_close(mux);
    mp4_h26x_write_close(&video);
    return status;
}

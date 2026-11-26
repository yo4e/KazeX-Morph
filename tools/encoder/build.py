"""Rebuild the shipped browser encoder with Zig 0.14.1 (zig cc)."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "vendor/encoder/encoder.wasm"
HASHES = {
    "minih264e.h": "04c9d720101945c2949224892a0fabee17e150c470f262936192e792d7d2fdf5",
    "minimp4.h": "3af7a268623aa1ba87a3e78d596aaf05bbdbec5cd5fe37c5ef67e2629691e494",
}

# Add BT.709 primaries, sRGB transfer and BT.709 matrix, studio range.
VUI = """
    U1(1); // vui_parameters_present_flag
    U1(0); // aspect_ratio_info_present_flag
    U1(0); // overscan_info_present_flag
    U1(1); // video_signal_type_present_flag
    U(3,5); U1(0); U1(1); // unspecified video format, studio range, colour description
    U(8,1); U(8,13); U(8,1); // primaries, transfer, matrix
    U1(0); // chroma_loc_info_present_flag
    U1(0); // timing_info_present_flag (MP4 sample table supplies frame durations)
    U1(0); U1(0); // nal_hrd_parameters_present_flag, vcl_hrd_parameters_present_flag
    U1(0); U1(0); // pic_struct_present_flag, bitstream_restriction_flag
"""

def replace(text, original, replacement):
    if text.count(original) != 1:
        raise ValueError(f"Unexpected upstream source near {original}")
    return text.replace(original, replacement)

with tempfile.TemporaryDirectory() as tmp:
    for name, checksum in HASHES.items():
        original = (HERE / "upstream" / name).read_bytes()
        if hashlib.sha256(original).hexdigest() != checksum:
            raise ValueError(f"Upstream checksum mismatch: {name}")
        text = original.decode()
        if name == "minih264e.h":
            text = replace(text, "U1(0);      // vui_parameters_present_flag", VUI)
            text = replace(text, "U(8, plim->level);",
                           "int min_level = throughput_level(enc->frame.nmb);\n"
                           "    U(8, plim->level > min_level ? plim->level : min_level);")
        else:
            # This encoder has one track and never changes SPS/PPS identifiers.
            text = replace(text, "#define MINIMP4_TRANSCODE_SPS_ID  1",
                           "#define MINIMP4_TRANSCODE_SPS_ID  0")
            text = replace(text, "#define MOOV_TIMESCALE 1000", "#define MOOV_TIMESCALE 90000")
        (Path(tmp) / name).write_text(text)
    subprocess.run([
        os.environ.get("ZIG", "zig"), "cc", "-target", "wasm32-wasi", "-mcpu=mvp",
        "-O3", "-DNDEBUG", "-fno-stack-protector", "-mexec-model=reactor",
        "-Wl,--strip-all", "-Wl,--export-memory", "-Wl,-z,stack-size=1048576",
        "-Wl,--max-memory=402653184", "-I", tmp, str(HERE / "encoder.c"), "-o", str(OUT),
    ], check=True)
    OUT.chmod(0o644)

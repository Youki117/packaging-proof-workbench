"""Run the local packaging OCR model and return coordinates on the source image."""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import rapidocr
from PIL import Image, ImageOps
from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR


class PackagingOCR(RapidOCR):
    def build_final_output(self, ori_img, det_res, cls_res, rec_res, cropped_img_list, op_record):
        # RapidOCR 3.10 recognizes flipped lines but calculates the word boxes in the original reading direction.
        self.flipped_lines = []
        if cls_res.cls_res and rec_res.txts and rec_res.scores:
            self.flipped_lines = [
                "180" in label and score > self.cfg.Cls.cls_thresh
                for (label, score), text, confidence in zip(
                    cls_res.cls_res, rec_res.txts, rec_res.scores, strict=True
                )
                if text.strip() and confidence >= self.text_score
            ]
        return super().build_final_output(ori_img, det_res, cls_res, rec_res, cropped_img_list, op_record)


def engine_for(prepare: bool) -> RapidOCR:
    model_dir = Path(rapidocr.__file__).with_name("models")
    model_files = {
        "Det": "PP-OCRv6_det_medium.onnx",
        "Cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "Rec": "PP-OCRv6_rec_medium.onnx",
    }
    cv2.setNumThreads(1)
    options = {
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Rec.ocr_version": OCRVersion.PPOCRV6,
        "Det.model_type": ModelType.MEDIUM,
        "Rec.model_type": ModelType.MEDIUM,
        "EngineConfig.openvino.inference_num_threads": 6,
        "Global.max_side_len": 2400,
        "Global.return_word_box": True,
        "Global.return_single_char_box": True,
        "Global.log_level": "warning",
    }
    for stage, filename in model_files.items():
        options[f"{stage}.engine_type"] = EngineType.OPENVINO
        if not prepare:
            model = model_dir / filename
            if not model.is_file():
                raise FileNotFoundError(filename)
            options[f"{stage}.model_path"] = str(model)
    return PackagingOCR(params=options)


def normalized_box(points, width: int, height: int) -> list[float]:
    xs, ys = zip(*points)
    left = max(0, min(width, float(min(xs)))) / width
    top = max(0, min(height, float(min(ys)))) / height
    right = max(0, min(width, float(max(xs)))) / width
    bottom = max(0, min(height, float(max(ys)))) / height
    return [left, top, right - left, bottom - top]


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--image", type=Path)
    args = parser.parse_args()
    engine = engine_for(args.prepare)
    if args.prepare:
        sample = np.full((110, 320, 3), 255, dtype=np.uint8)
        cv2.putText(sample, "OCR 123", (20, 72), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3)
        if not engine(sample).txts:
            raise RuntimeError("OCR setup self-check found no text")
        print("PP-OCRv6 is ready.")
        return

    with Image.open(args.image) as source:
        proof = ImageOps.exif_transpose(source).convert("RGBA")
    image = Image.new("RGB", proof.size, "white")
    image.paste(proof, mask=proof.getchannel("A"))
    result = engine(image)
    lines = []
    if result.txts:
        height, width = result.img.shape[:2]
        word_results = result.word_results or [()] * len(result.txts)
        rotated = engine.flipped_lines or [False] * len(result.txts)
        for text, polygon, words, flipped in zip(result.txts, result.boxes, word_results, rotated, strict=True):
            line_box = normalized_box(polygon, width, height)
            if not line_box[2] or not line_box[3]:
                continue
            chars = []
            for character, _, points in words or ():
                if character.strip() and points is not None:
                    box = normalized_box(points, width, height)
                    if box[2] and box[3]:
                        if flipped:
                            left, top, line_width, line_height = line_box
                            box[0] = min(1 - box[2], max(0, 2 * left + line_width - box[0] - box[2]))
                            box[1] = min(1 - box[3], max(0, 2 * top + line_height - box[1] - box[3]))
                        chars.append({"text": character, "box": box})
            lines.append({"text": text, "box": line_box, "words": chars, **({"rotation": 180} if flipped else {})})
    sys.stdout.write(json.dumps({"lines": lines}, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()

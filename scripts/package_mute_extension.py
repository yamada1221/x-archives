"""Build a deterministic unpacked-extension ZIP using only the standard library."""
from pathlib import Path
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extensions/mute-screen-capture"


def package():
    manifest = json.loads((SOURCE / "manifest.json").read_text())
    output = ROOT / "downloads" / f"x-tracker-mute-capture-v{manifest['version']}.zip"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(SOURCE.iterdir()):
            if not path.is_file():
                continue
            entry = zipfile.ZipInfo("x-tracker-mute-capture/" + path.name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
    return output


if __name__ == "__main__":
    print(package())

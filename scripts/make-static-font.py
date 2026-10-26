#!/usr/bin/env python3
"""Build static font instances from a variable font (for the examples).

Why: Chromium cannot embed a variable font as a CID font, so it falls back to
one Type3 object per glyph 鈥?bigger PDFs, poor print-shop compatibility.
Instantiating the variable font at fixed weights yields clean Type0 subsets.

The Noto Sans SC examples ship with this repository were rendered with the
static instances produced by this script (family "Noto Sans SC Static").

Usage:
    python make-static-font.py --source C:\\Windows\\Fonts\\NotoSansSC-VF.ttf
    python make-static-font.py --source ... --install     # per-user install
    python make-static-font.py --uninstall                # remove them again

No admin rights are needed; "installed" fonts live in
%LOCALAPPDATA%\\Microsoft\\Windows\\Fonts and one HKCU registry key.
"""

import argparse
import os
import sys

try:
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
except ImportError:  # pragma: no cover
    sys.exit("fontTools is required:  pip install fonttools")

FAMILY = "Noto Sans SC Static"
WEIGHTS = [(400, "Regular", "NotoSansSCStatic-Regular.ttf"), (700, "Bold", "NotoSansSCStatic-Bold.ttf")]
REG_PATH = r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"


def font_dir() -> str:
    base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    return os.path.join(base, "Microsoft", "Windows", "Fonts")


def build(src: str, outdir: str) -> list[dict]:
    made = []
    for weight, sub, filename in WEIGHTS:
        f = TTFont(src)
        inst = instantiateVariableFont(f, {"wght": weight}, updateFontNames=False, inplace=True)
        inst["OS/2"].usWeightClass = weight
        if weight >= 700:
            inst["OS/2"].fsSelection = (inst["OS/2"].fsSelection & ~0x40) | 0x20
            inst["head"].macStyle |= 0x01
        else:
            inst["OS/2"].fsSelection = (inst["OS/2"].fsSelection & ~0x20) | 0x40
            inst["head"].macStyle &= ~0x01

        psname = "NotoSansSCStatic-" + sub
        for rec in list(inst["name"].names):
            nid = rec.nameID
            if nid == 1:
                rec.string = FAMILY
            elif nid == 2:
                rec.string = sub
            elif nid == 3:
                rec.string = psname + ";derived-from-variable-font"
            elif nid == 4:
                rec.string = FAMILY if sub == "Regular" else FAMILY + " " + sub
            elif nid == 6:
                rec.string = psname
            elif nid in (16, 17):
                rec.string = FAMILY if nid == 16 else sub

        made.append({"weight": weight, "sub": sub, "path": save_static(inst, outdir, filename)})
        print(f"  built {made[-1]['path']}  ({os.path.getsize(made[-1]['path']) / 1048576:.1f} MB)")
    return made


def save_static(inst, outdir: str, filename: str) -> str:
    """Write the static font; fall back to a suffixed name if the target is in use.

    Windows locks a font file while any process has it mapped, and existing
    browsers keep it mapped even after the registry entry is gone. Writing the
    same family under a new file name still resolves the same CSS family.
    """
    os.makedirs(outdir, exist_ok=True)
    target = os.path.join(outdir, filename)
    tmp = target + ".tmp"
    inst.save(tmp)
    try:
        os.replace(tmp, target)
        return target
    except PermissionError:
        stem = filename[:-4]
        for i in range(2, 99):
            alt = os.path.join(outdir, f"{stem}-{i}.ttf")
            try:
                os.replace(tmp, alt)
                print(f"  note: {filename} is locked, wrote {os.path.basename(alt)} instead")
                return alt
            except PermissionError:
                continue
        os.remove(tmp)
        raise


def install(made: list[dict]) -> None:
    import winreg

    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_PATH)
    try:
        for item in made:
            name = f"{FAMILY} {item['sub']} (TrueType)"
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, item["path"])
            print(f"  registered {name} -> {os.path.basename(item['path'])}")
    finally:
        key.Close()
    print("  done 鈥?new processes will see the family; sign out/in if the browser does not.")


def uninstall() -> None:
    import glob
    import winreg

    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_ALL_ACCESS)
    # drop every value this tool may have written, including suffixed variants
    i = 0
    while True:
        try:
            name, _value, _kind = winreg.EnumValue(key, i)
        except OSError:
            break
        if name.startswith(FAMILY):
            winreg.DeleteValue(key, name)
            print(f"  unregistered {name}")
        else:
            i += 1
    key.Close()

    for path in glob.glob(os.path.join(font_dir(), "NotoSansSCStatic-*.ttf")):
        try:
            os.remove(path)
            print(f"  deleted {os.path.basename(path)}")
        except PermissionError:
            print(f"  ! {os.path.basename(path)} is locked by a running browser 鈥?it will disappear after sign-out")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build/install static instances of a variable font.")
    ap.add_argument("--source", help="path to the variable font (.ttf/.otf)")
    ap.add_argument("--outdir", default=font_dir(), help="where to write the static files")
    ap.add_argument("--install", action="store_true", help="register them for the current user")
    ap.add_argument("--uninstall", action="store_true", help="remove the per-user registration and files")
    args = ap.parse_args()

    if args.uninstall:
        uninstall()
        return 0

    if not args.source:
        ap.error("--source is required (unless --uninstall)")
    if not os.path.exists(args.source):
        ap.error(f"source font not found: {args.source}")

    print(f"building {FAMILY} from {args.source}")
    made = build(args.source, args.outdir)
    if args.install:
        install(made)
    else:
        print("  (not installed; pass --install to register them for this user)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

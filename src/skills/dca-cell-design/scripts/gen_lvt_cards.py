#!/usr/bin/env python3
"""gen_lvt_cards.py -- extend the bundled sky130 lvt switch library (clone-based).

The transcribed library (sky130_fd_pr__nfet_01v8_lvt.scs) carries per-geometry
flattened bsim4 cards. At l=0.15 um every geometry picks the SAME bin
(nlowvt_model.8), so all cards share one parameter body and differ only in the
card name and rsh = 89.1*nf/w + 443.5 (recipe: sky130-spectre-models
gen/gen_sky130_spectre.py; see ParseSky130toSpectre.md rule 25 for the name
encoding). This script therefore regenerates cards by CLONING a verified card
body -- it first proves that every card in the source file shares one body
(modulo name/rsh) and that the rsh formula reproduces each existing value,
then appends the requested geometries. Old cards pass through verbatim.

Card naming: nlowvt_model__w<W>p<N>f<N> -- fractional W encodes its decimal
point as 'p' (w61.7 -> w61p7); integer W carries no 'p' (w10, w100).

Usage:
  python -I gen_lvt_cards.py [--src <model.scs>] [--out <model.scs>]
  Defaults: the bundled sky130proc library, regenerated in place (atomic
  tmp+rename). Re-running on an already-extended file is a friendly no-op.
"""
import argparse
import os
import sys

BUNDLED = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..',
    'sky130_examples', 'sky130proc', 'sky130_fd_pr__nfet_01v8_lvt.scs'))

# Full 5x5 local grids around the two worked design classes (per-finger width
# ~= 2 um, the library convention). The grid centers are the existing cards
# (w43.3/nf22 and w61.7/nf31), so each grid adds 24 new cards.
L_UM = 0.15
GRID_M2 = ([L_UM, w, nf] for w in (35.3, 39.3, 43.3, 47.3, 51.3)
           for nf in (18, 20, 22, 24, 26))          # shunt-switch class
GRID_M1 = ([L_UM, w, nf] for w in (53.7, 57.7, 61.7, 65.7, 69.7)
           for nf in (27, 29, 31, 33, 35))          # bypass-switch class


def card_name(w_um, nf):
    return "nlowvt_model__w%snf%d" % (str(w_um).replace(".", "p"), nf)


def rsh_of(w_um, nf):
    return 89.1 * nf / w_um + 443.5


def parse_cards(text):
    """Split the file into (header, [card_block_strings]) and per-card facts.

    A card block = its '// l=...' comment line, the 'model ... \' statement
    lines (the final line carries the rsh token, no continuation), and the
    trailing blank line.
    """
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]                    # drop the artifact of split
    cards = []
    header = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("// l="):
            block = [lines[i]]
            i += 1
            block.append(lines[i])            # 'model <name> bsim4 \'
            name = lines[i].split()[1]
            while lines[i].rstrip().endswith("\\"):
                i += 1
                block.append(lines[i])
            rsh_line = lines[i]               # final line: '    rsh=<value>'
            rsh = float(rsh_line.split("rsh=")[1])
            i += 1
            if i < len(lines) and lines[i] == "":
                block.append("")
                i += 1
            cards.append({"name": name, "rsh": rsh,
                          "text": "\n".join(block) + "\n"})
        else:
            header.append(lines[i])
            i += 1
    return "\n".join(header) + "\n", cards


def _swap_rsh_token(text, new_rsh):
    """Replace only the rsh= value on the card's final model line, keeping
    every other token (rsh shares the line with lodeta0) and the trailing
    blank line exactly as in the template."""
    import re
    lines = text.split("\n")
    idx = max(i for i, l in enumerate(lines) if l.strip())
    m = re.search(r"(?<![A-Za-z0-9])rsh=[-0-9.eE+]+\s*$", lines[idx])
    if m is None:
        raise SystemExit("FATAL: no rsh token on the card's final line: %r"
                         % lines[idx])
    lines[idx] = lines[idx][: m.start()] + "rsh=%r" % new_rsh
    return "\n".join(lines)


def card_body_key(card):
    """Model statement with the name and the rsh VALUE blanked -> identity key.

    The per-card comment line (first line of the block) is dropped: it embeds
    w/nf/rsh by definition. Only the rsh value substring is blanked on the
    final line, so a structural difference there (a lost neighboring token)
    still changes the key.
    """
    import re
    text = card["text"]
    first_nl = text.find("\n")
    body = text[first_nl + 1:]
    body = body.replace(card["name"], "@NAME@", 1)
    body = re.sub(r"(?<![A-Za-z0-9])rsh=[-0-9.eE+]+", "rsh=@RSH@", body)
    return body


def make_card(template, name, rsh, l_um, w_um, nf):
    """Clone a verified card block with a new name/rsh and comment line."""
    text = template["text"]
    text = text.replace(template["name"], name, 1)
    text = _swap_rsh_token(text, rsh)
    comment = ("// l=%g w=%g nf=%d -> bin nlowvt_model.8  rsh=%.4f "
               "delvto=0 (folded into vth0)" % (l_um, w_um, nf, rsh))
    # swap the template's comment line (always the first line of the block)
    first_nl = text.find("\n")
    return comment + text[first_nl:]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", default=BUNDLED,
                    help="existing model .scs file (default: the bundled library)")
    ap.add_argument("--out", default=None,
                    help="output .scs (default: regenerate --src in place)")
    ap.add_argument("--check", action="store_true",
                    help="verify the source only; no new cards, no output")
    args = ap.parse_args(argv)

    with open(args.src, "r", encoding="ascii", newline="") as f:
        src = f.read()
    header, cards = parse_cards(src)

    # --- verification pass on the source ---------------------------------
    keys = {card_body_key(c) for c in cards}
    if len(keys) != 1:
        sys.exit("FATAL: card bodies differ (expected one shared body): %d"
                 % len(keys))
    for c in cards:
        w, nf = None, None
        for tok in c["text"].splitlines()[0].split():
            if tok.startswith("w="):
                w = float(tok[2:])
            if tok.startswith("nf="):
                nf = int(tok[3:])
        if rsh_of(w, nf) != c["rsh"]:
            sys.exit("FATAL: rsh mismatch for %s: formula %r vs file %r"
                     % (c["name"], rsh_of(w, nf), c["rsh"]))
    names = [c["name"] for c in cards]
    if len(set(names)) != len(names):
        sys.exit("FATAL: duplicate card names in source")
    print("[gen] source OK: %d cards, one shared body, rsh formula verified"
          % len(cards))

    if args.check:
        return 0

    # --- build the new cards ----------------------------------------------
    template = cards[0]
    existing = set(names)
    new_cards = []
    for l_um, w, nf in list(GRID_M2) + list(GRID_M1):
        name = card_name(w, nf)
        if name in existing:
            continue                          # grid center already shipped
        new_cards.append((name, make_card(template, name, rsh_of(w, nf),
                                          l_um, w, nf)))
    if not new_cards:
        print("[gen] all grid cards already present -- nothing to do")
        return 0

    out_text = src if src.endswith("\n") else src + "\n"
    out_text += "".join(t for _, t in new_cards)

    # --- verification pass on the output ----------------------------------
    _, out_cards = parse_cards(out_text)
    if len(out_cards) != len(cards) + len(new_cards):
        sys.exit("FATAL: output card count %d != expected %d"
                 % (len(out_cards), len(cards) + len(new_cards)))
    keys = {card_body_key(c) for c in out_cards}
    if len(keys) != 1:
        sys.exit("FATAL: output card bodies differ")
    for c in out_cards:
        w, nf = None, None
        for tok in c["text"].splitlines()[0].split():
            if tok.startswith("w="):
                w = float(tok[2:])
            if tok.startswith("nf="):
                nf = int(tok[3:])
        if rsh_of(w, nf) != c["rsh"]:
            sys.exit("FATAL: output rsh mismatch for %s" % c["name"])
    all_names = [c["name"] for c in out_cards]
    if len(set(all_names)) != len(all_names):
        sys.exit("FATAL: duplicate names in output")
    out_b = out_text.encode("ascii")
    if b"\r" in out_b or any(b > 127 for b in out_b):
        sys.exit("FATAL: output not pure-ASCII/LF")
    if not out_text.startswith(src):
        sys.exit("FATAL: output prefix is not byte-identical to the source")

    out_path = args.out or args.src
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="ascii", newline="\n") as f:
        f.write(out_text)
    os.replace(tmp, out_path)
    print("[gen] wrote %s: %d cards (%d new), %d bytes, prefix identical"
          % (out_path, len(out_cards), len(new_cards), len(out_b)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

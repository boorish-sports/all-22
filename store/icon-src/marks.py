from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

GEORGIA = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
N = 1024
INK = (18, 18, 18)            # the extension's black
GOLD = (177, 146, 79)         # the extension's gold
GOLD_DIM = (120, 99, 54)      # for the quieter marks


def ground(n):
    im = Image.new("RGB", (n, n), INK)
    # a whisper of grain and a centre lift, so the black is not a flat void
    g = Image.effect_noise((n, n), 10).filter(ImageFilter.GaussianBlur(1.5))
    g = g.point(lambda v: 236 + (v - 128) * 0.3)
    im = ImageChops.multiply(im, Image.merge("RGB", (g, g, g)).point(lambda v: min(255, int(v * 255 / 236))))
    v = Image.new("L", (n, n), 0)
    ImageDraw.Draw(v).ellipse((-n * .1, -n * .1, n * 1.1, n * 1.1), fill=255)
    v = v.filter(ImageFilter.GaussianBlur(n * .3))
    lift = ImageChops.add(im, Image.new("RGB", (n, n), (10, 10, 10)))
    return Image.composite(lift, im, v)


def rounded(im, r):
    n = im.size[0]
    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    m = Image.new("L", (n, n), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, n - 1, n - 1), r, fill=255)
    out.paste(im, (0, 0), m)
    return out


def ticks(d, n, y, up, count=9, long_every=4, h=0.05, w=0.011, color=GOLD, x0=0.07, x1=0.93):
    for i in range(count):
        x = n * (x0 + (x1 - x0) * i / (count - 1))
        hh = n * (h * (1.7 if i % long_every == 0 else 1))
        d.rectangle((x - n * w / 2, y - hh if up else y, x + n * w / 2, y if up else y + hh), fill=color)


def numerals(d, n, size, y_frac, gap, color=GOLD):
    """Draws 2 | 2 and returns the right numeral's box (x0, y0, x1, y1)."""
    f = ImageFont.truetype(GEORGIA, int(n * size))
    bb = d.textbbox((0, 0), "2", font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    right = None
    for side in (-1, 1):
        x = n * .5 + side * (n * gap + tw / 2) - tw / 2 - bb[0]
        y = n * y_frac - th / 2 - bb[1]
        d.text((x, y), "2", font=f, fill=color)
        if side == 1:
            right = (x + bb[0], y + bb[1], x + bb[2], y + bb[3])
    return right


def pennant(d, box, n, color=GOLD, at=0.22, gap=0.03, w=0.11, h=0.085):
    """The tapered flag painted beside a field numeral: base against the numeral's
    right edge, a little below its top, pointing away from it."""
    x0, y0, x1, y1 = box
    x = x1 + n * gap
    y = y0 + (y1 - y0) * at
    d.polygon([(x, y - n * h / 2), (x + n * w, y), (x, y + n * h / 2)], fill=color)


def line(d, n, w=0.026, color=GOLD, y0=0, y1=None):
    d.rectangle((n * (.5 - w / 2), y0, n * (.5 + w / 2), n if y1 is None else y1), fill=color)


def v1():
    # A in black and gold: numerals pulled in, pennant beside the right 2, sideline below
    im = ground(N); d = ImageDraw.Draw(im, "RGBA")
    line(d, N)
    box = numerals(d, N, .40, .45, .07)
    pennant(d, box, N)
    d.rectangle((0, N * .885, N, N * .915), fill=GOLD)
    ticks(d, N, N * .885, True)
    return rounded(im, N * .18)


def v2():
    # same, with the ticks as a quieter hash row top and bottom and no solid sideline
    im = ground(N); d = ImageDraw.Draw(im, "RGBA")
    line(d, N)
    box = numerals(d, N, .42, .50, .07)
    pennant(d, box, N)
    ticks(d, N, N * .07, False, count=7, long_every=3, h=.045, color=GOLD_DIM)
    ticks(d, N, N * .93, True, count=7, long_every=3, h=.045, color=GOLD_DIM)
    return rounded(im, N * .18)


def v3():
    # the sideline as a full gold band, numerals a touch larger, pennant higher on the 2
    im = ground(N); d = ImageDraw.Draw(im, "RGBA")
    line(d, N, y1=N * .86)
    box = numerals(d, N, .44, .44, .065)
    pennant(d, box, N, at=0.14, gap=0.025)
    d.rectangle((0, N * .86, N, N), fill=GOLD)
    ticks(d, N, N * .86, False, count=9, long_every=4, h=.045, color=INK)
    return rounded(im, N * .18)


def v4():
    # gold frame instead of a sideline, mark alone in the middle
    im = ground(N); d = ImageDraw.Draw(im, "RGBA")
    d.rounded_rectangle((N * .035, N * .035, N * .965, N * .965), N * .15, outline=GOLD, width=int(N * .022))
    line(d, N, y0=N * .035, y1=N * .965)
    box = numerals(d, N, .40, .50, .07)
    pennant(d, box, N)
    ticks(d, N, N * .965 - N * .011, True, count=9, long_every=4, h=.04)
    return rounded(im, N * .18)


if __name__ == "__main__":
    opts = {"A1-sideline": v1, "A2-hash-rows": v2, "A3-gold-band": v3, "A4-framed": v4}
    sheet = Image.new("RGB", (4 * 300, 470), (60, 60, 60))
    sd = ImageDraw.Draw(sheet)
    lf = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 22)
    for i, (name, fn) in enumerate(opts.items()):
        im = fn()
        im.resize((128, 128), Image.LANCZOS).save(f"{name}.png")
        im.save(f"{name}-1024.png")
        x = i * 300 + 22
        big = im.resize((256, 256), Image.LANCZOS)
        sheet.paste(big, (x, 20), big)
        for j, s in enumerate((128, 48, 32)):
            sm = im.resize((s, s), Image.LANCZOS)
            sheet.paste(sm, (x + [0, 140, 200][j], 300), sm)
        sd.text((x, 440), name, font=lf, fill=(230, 230, 230))
    sheet.save("options2.png")
    print("ok")

from marks import *   # run from this folder: python3 make_icon.py
def final():
    im = ground(N); d = ImageDraw.Draw(im, "RGBA")
    band = N * .84                       # thick gold sideline filling the bottom edge
    line(d, N, y1=band)
    box = numerals(d, N, .40, .43, .07)
    # no pennant: the mark is the yard line and the two 2s
    d.rectangle((0, band, N, N), fill=GOLD)
    ticks(d, N, band, True, count=9, long_every=4, h=.045)
    return rounded(im, N * .18)
im = final()
im.save("final-1024.png")
for s in (16, 32, 48, 128, 512):
    im.resize((s, s), Image.LANCZOS).save(f"final-{s}.png")
sheet = Image.new("RGB", (620, 300), (60, 60, 60))
big = im.resize((256, 256), Image.LANCZOS); sheet.paste(big, (20, 20), big)
x = 300
for s in (128, 48, 32, 16):
    sm = im.resize((s, s), Image.LANCZOS); sheet.paste(sm, (x, 20), sm); x += s + 20
sheet.save("final-sheet.png"); print("ok")

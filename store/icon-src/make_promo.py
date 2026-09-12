# The 440x280 small promo tile for the Chrome Web Store: the icon beside the name.
from PIL import Image, ImageDraw, ImageFont
F = "/System/Library/Fonts/Supplemental/"
INK, GOLD, WHITE, GREY = (18, 18, 18), (177, 146, 79), (240, 240, 240), (200, 200, 200)
im = Image.new("RGB", (440, 280), INK)
icon = Image.open("../icon128.png").convert("RGBA")
im.paste(icon, (36, 76), icon)
d = ImageDraw.Draw(im)
big = ImageFont.truetype(F + "Arial Bold.ttf", 34)
small = ImageFont.truetype(F + "Arial Bold.ttf", 15)
d.text((182, 84), "All-22", font=big, fill=GOLD)
d.text((182, 124), "Film Search", font=big, fill=WHITE)
d.text((182, 176), "Search play-by-play. Watch the clip.", font=small, fill=GREY)
im.save("../promo-440x280.png")
print("promo ok")

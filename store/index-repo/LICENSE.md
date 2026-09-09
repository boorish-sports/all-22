# Licences for all-22-index

## The build script

`build_index.py` is released under the MIT License.

    MIT License

    Copyright (c) 2026 Boorish

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## The published index (Releases)

The `plays_*.db.gz` files published under Releases are derived from
[nflverse-data](https://github.com/nflverse/nflverse-data), which is licensed
under the Creative Commons Attribution 4.0 International licence
(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). The charting columns
(`is_play_action`, `is_motion`, `n_blitzers`, ...) are FTN Data's charting,
published by nflverse under the same licence.

They are a modified form of that data: columns were dropped, FTN charting was
joined onto play-by-play, and the result was loaded into SQLite. The index is
therefore also offered under **CC BY 4.0**. If you redistribute it or anything
derived from it, credit **nflverse** and **FTN Data** and link to this notice.
No endorsement by nflverse or FTN Data is implied.

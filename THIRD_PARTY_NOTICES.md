# Third-party notices

The project's MIT license covers only original project code and other original project contributions. It does not relicense third-party software, wiki-authored metadata, Arknights names, data, images, icons, or other game content described below.

## Arknights data and images

Static game data and compressed images are sourced from `arkntools/arknights-toolbox-data`. That repository declares MIT for its own software and original contributions, but this does not convert extracted Arknights content into MIT-licensed material. Some synchronized fields also come from `Kengxxiao/ArknightsGameData`, which is based in part on `MooncellWiki/OpenArknightsFBS`; those two repositories did not expose a repository-wide license at the time of this audit.

`arkntools/arknights-toolbox-data` MIT notice:

Copyright (c) 2023 神代綺凛

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Mastery rank images, skill icons, elite rank images, module stage images, and module type icons under `resources/images` are original game PNG files retrieved through PRTS Wiki-hosted media URLs. Source URLs and local mappings are maintained by `scripts/sync-prts-assets.mjs` and recorded in `resources/images/prts-assets.json` when available.

High-resolution profession watermarks in `resources/images/profession-hd` are processed from original game PNG files in the public `MooncellWiki/prts-design` asset collection. Exact source paths and the performed transparency processing are recorded in `resources/images/profession-hd/source.json`. That repository did not expose a repository-wide license at the time of this audit.

PRTS-authored operator and material metadata is queried from PRTS, selected, normalized, and serialized into local JSON by the synchronization scripts. PRTS declares its wiki content under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); attribution: PRTS contributors, <https://prts.wiki/>. Original game content hosted by PRTS remains subject to its original rights and is not relicensed by this notice.

Arknights game resources, names, data, and images are copyright Shanghai Hypergryph Network Technology Co., Ltd. and/or its affiliates. They are included only to present locally calculated account planning information. Source attribution records provenance; it is not a claim of ownership or a substitute for permission from the relevant rights holder.

## Lucide sidebar icons

Sidebar navigation icons are derived from Lucide, sourced from the official `lucide-icons/lucide` repository at commit `b1a94838ac536c1cef5aaa802f78c07b30cac913`.

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Lucide's upstream license also preserves the following notice for glyphs derived from Feather:

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Bundled npm dependencies

Production npm dependencies and their complete installed license/notice texts are generated from `package-lock.json` during the build and shipped as `THIRD_PARTY_LICENSES.txt`.

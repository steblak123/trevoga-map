# Джерела шарів карти

Файли цієї папки зібрано скриптом [`build/make-basemap.py`](../../../build/make-basemap.py) у проєкції `app/assets/map.json`.

| Файли | Що | Джерело і ліцензія |
| --- | --- | --- |
| `sat/` | супутниковий знімок | **Sentinel-2 cloudless 2017** — <https://s2maps.eu> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2017), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Змінено: перепроєктовано, обрізано по кордону України, трохи затемнено. |
| `vector.js` — дороги, залізниці; `places.js`, `places-extra.js` — містечка й села | | © учасники **OpenStreetMap**, [ODbL 1.0](https://www.openstreetmap.org/copyright); вивантаження Humanitarian OpenStreetMap Team (HOT) на [HDX](https://data.humdata.org/organization/hot). Похідні бази даних у `vector.js` і `places.js` поширюються на умовах ODbL. |
| `vector.js` — вода, річки, забудова; `places.js` — великі міста | | **Natural Earth** (public domain), <https://www.naturalearthdata.com>. |
| `places.js` — назви й центри районів | | межі OCHA / HDX COD-AB Ukraine, [CC BY-IGO](https://creativecommons.org/licenses/by/3.0/igo/) (через `app/assets/map.json`). |

При сильному наближенні, коли є інтернет, віджет бере плитки того ж Sentinel-2 cloudless 2017 прямо з
`tiles.maps.eox.at` (браузер тримає їх у кеші).

У віджеті, коли шар увімкнено, у верхньому лівому куті карти є посилання на ці джерела.

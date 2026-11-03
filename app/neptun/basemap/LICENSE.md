# Джерела шарів карти

Файли цієї папки зібрано скриптом [`build/make-basemap.py`](../../../build/make-basemap.py) у проєкції `app/assets/map.json`.

| Файли | Що | Джерело і ліцензія |
| --- | --- | --- |
| `sat/` | супутниковий знімок | **Sentinel-2 cloudless 2017** — <https://s2maps.eu> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2017), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Змінено: перепроєктовано, обрізано по кордону України, трохи затемнено. |
| `vector.js` — дороги, залізниці, назви містечок | | © учасники **OpenStreetMap**, [ODbL 1.0](https://www.openstreetmap.org/copyright); вивантаження Humanitarian OpenStreetMap Team (HOT) на [HDX](https://data.humdata.org/organization/hot). Похідна база даних у `vector.js` поширюється на умовах ODbL. |
| `vector.js` — вода, річки, забудова, назви великих міст | | **Natural Earth** (public domain), <https://www.naturalearthdata.com>. |

У віджеті, коли шар увімкнено, у верхньому лівому куті карти є посилання на ці джерела.

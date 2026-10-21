# devicon (provider logos)

The provider logos in `logos.tsx` are taken from **devicon v2.16.0**, https://github.com/devicons/devicon
(files fetched from `https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/<name>/<name>-<variant>.svg`):

| Provider   | devicon file                                   | Changes                                                   |
|------------|------------------------------------------------|-----------------------------------------------------------|
| SQL Server | `microsoftsqlserver/microsoftsqlserver-plain.svg` | none besides trimming                                   |
| Oracle     | `oracle/oracle-original.svg`                   | only the "O" of the wordmark, cropped to it               |
| PostgreSQL | `postgresql/postgresql-original.svg`           | black outline painted from the `--logo-ink` token         |
| SQLite     | `sqlite/sqlite-original.svg`                   | feather painted from `--logo-sqlite-feather`              |
| Redis      | `redis/redis-original.svg`                     | reds painted from `--logo-redis` / `--logo-redis-side`    |
| MongoDB    | `mongodb/mongodb-plain.svg`                    | recoloured to the `-original` variant's green (`#439934`) |
| Kafka      | `apachekafka/apachekafka-original.svg`         | black painted from `--logo-ink`                           |

All files were trimmed by hand: metadata, ids and wrapper groups removed, path coordinates rounded to 0.01, viewBoxes
cropped to the artwork. The token-painted parts keep the original colour in the light theme and use a lighter one in
the dark theme (see `src/theme/tokens.css`).

devicon is released under the MIT License:

```
The MIT License (MIT)

Copyright (c) 2015 konpa

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
```

The logos themselves are trademarks of their owners (Microsoft, Oracle, the PostgreSQL Global Development Group,
SQLite, Redis Ltd., MongoDB Inc. and the Apache Software Foundation). They are used only to identify the product a
connection points to.

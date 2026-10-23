# simple-icons (provider logos)

Two provider logos in `logos.tsx` are taken from **simple-icons**, https://github.com/simple-icons/simple-icons
(package `simple-icons` 16.35.0; files fetched from `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/<name>.svg`):

| Provider   | simple-icons file | Changes                                                                          |
|------------|-------------------|----------------------------------------------------------------------------------|
| ClickHouse | `clickhouse.svg`  | none besides trimming; painted from the `--provider-clickhouse` token           |
| Snowflake  | `snowflake.svg`   | the registered-trademark sign (first sub-paths) removed, viewBox cropped; painted from `--provider-snowflake` |

simple-icons is released under CC0 1.0 Universal (public domain dedication), https://creativecommons.org/publicdomain/zero/1.0/
The licence requires no attribution; it is recorded here for provenance.

The logos themselves are trademarks of their owners (ClickHouse, Inc. and Snowflake Inc.). They are used only to identify
the product a connection points to.

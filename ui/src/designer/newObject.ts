// Consoles opened by the New procedure / function / package / trigger wizard are "edit" consoles of an object that
// does not exist yet (EditSession.isNew): Ctrl+S creates it in the database instead of saving a .sql file. The user may
// rename the object in the template before saving, so its name is read back from the script's CREATE header.
import { api } from '../api/client';
import type { CatalogObjectType, Dialect, ObjectRef } from '../api/types';
import { catalogDatabase } from '../app/actions';
import { dbKey, useCatalog } from '../store/catalog';
import type { EditSession } from './store';

const IDENT = String.raw`(?:\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|` + '`[^`]+`' + String.raw`|[\p{L}_][\p{L}\p{N}_$#@]*)`;
const HEAD = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:TEMP(?:ORARY)?\s+)?` +
    String.raw`(?:PROCEDURE|PROC|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?` +
    `(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`,
  'iu',
);
const PART = new RegExp(IDENT, 'gu');

/** Comments blanked out (strings are left alone: a CREATE inside a literal before the header is not realistic). */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** A name as the user typed it (quoted or plain), as the server will store it. */
export function foldName(id: string, dialect: Dialect): string {
  return unquote(id.trim(), dialect);
}

function unquote(id: string, dialect: Dialect): string {
  if (id.startsWith('[')) return id.slice(1, -1).replace(/\]\]/g, ']');
  if (id.startsWith('"')) return id.slice(1, -1).replace(/""/g, '"');
  if (id.startsWith('`')) return id.slice(1, -1);
  // Unquoted names are folded the way the server stores them.
  if (dialect === 'plsql') return id.toUpperCase();
  if (dialect === 'pgsql') return id.toLowerCase();
  return id;
}

/**
 * Whether a new object's name is already taken: a new console runs CREATE OR ALTER / CREATE OR REPLACE, which would
 * silently overwrite an existing object of that name. Checks the server (the object's own definition) and the loaded
 * catalog (any object type with that name in the schema: SQL Server and Oracle names are unique per schema).
 */
export async function existingObjectNamed(edit: Pick<EditSession, 'connectionId' | 'database' | 'ref' | 'dialect'>): Promise<CatalogObjectType | null> {
  const hit = catalogObjectNamed(edit);
  if (hit) return hit;
  try {
    await api.ddl(edit.connectionId, edit.database, edit.ref);
    return edit.ref.type;
  } catch {
    // Not found is the expected answer; anything else (permissions, a dropped connection) is left to the CREATE itself.
    return null;
  }
}

/**
 * The type of an object with this name in the loaded catalog (the explorer's data), or null. Names compare the way the
 * server does: case-insensitively on SQL Server and SQLite, exactly on Oracle and PostgreSQL (names are stored folded).
 * PostgreSQL routines can be overloaded and share names across kinds, so only the same type counts there.
 */
export function catalogObjectNamed(edit: Pick<EditSession, 'connectionId' | 'database' | 'ref' | 'dialect'>): CatalogObjectType | null {
  if (!edit.ref.name) return null;
  const fold = (s: string) => (edit.dialect === 'tsql' || edit.dialect === 'sqlite' ? s.toLowerCase() : s);
  const db = useCatalog.getState().dbs[dbKey(edit.connectionId, catalogDatabase(edit.connectionId, edit.ref.database ?? edit.database))];
  const schemaName = edit.ref.schema ?? db?.defaultSchema ?? null;
  const schema = schemaName ? db?.loaded[schemaName] : undefined;
  const hit = schema?.objects.find((o) => fold(o.n) === fold(edit.ref.name) && (edit.dialect !== 'pgsql' || o.t === edit.ref.type));
  return hit?.t ?? null;
}

/** The object a new-object script creates: its name (and schema when qualified) from the first CREATE header. */
export function newObjectRef(text: string, edit: Pick<EditSession, 'ref' | 'dialect'>): ObjectRef {
  const m = HEAD.exec(stripComments(text));
  if (!m) return edit.ref;
  const [first, second] = m[1].match(PART) ?? [];
  if (!first) return edit.ref;
  const name = unquote(second ?? first, edit.dialect);
  const schema = second ? unquote(first, edit.dialect) : edit.ref.schema;
  return { ...edit.ref, name, schema };
}

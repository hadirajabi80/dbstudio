// JSON generator: a sample row object per table/view/query (for API mocking) or a JSON Schema (draft 2020-12).
import type { CgColumn, CgInput, CgObject, GeneratedFile } from '../model';
import { isTable } from '../model';
import type { CodegenOptions } from '../options';
import { membersOf, objectLabel, typeNameOf, type Member } from '../shape';
import type { ResolvedType } from '../types';
import { commentText } from '../writer';

function sampleValue(t: ResolvedType): unknown {
  switch (t.logical) {
    case 'bool':
      return true;
    case 'uint8':
    case 'int16':
    case 'int32':
    case 'int64':
      return 1;
    case 'decimal':
      return t.scale ? Number((1.5).toFixed(Math.min(t.scale, 2))) : 1;
    case 'float32':
    case 'float64':
      return 1.5;
    case 'date':
      return '2026-01-31';
    case 'datetime':
      return '2026-01-31T12:00:00';
    case 'datetimeoffset':
      return '2026-01-31T12:00:00+00:00';
    case 'time':
      return '12:00:00';
    case 'interval':
      return 'PT1H';
    case 'guid':
      return '00000000-0000-0000-0000-000000000000';
    case 'binary':
    case 'rowversion':
      return 'AAECAw==';
    case 'xml':
      return '<root />';
    case 'json':
      return {};
    case 'string':
      return t.length ? 'text'.slice(0, Math.max(1, Math.min(4, t.length))) : 'text';
    default:
      return null;
  }
}

function schemaFor(m: Member): Record<string, unknown> {
  const t = m.type;
  const s: Record<string, unknown> = {};
  switch (t.logical) {
    case 'bool':
      s.type = 'boolean';
      break;
    case 'uint8':
    case 'int16':
    case 'int32':
    case 'int64':
      s.type = 'integer';
      if (t.logical === 'uint8') Object.assign(s, { minimum: 0, maximum: 255 });
      break;
    case 'decimal':
    case 'float32':
    case 'float64':
      s.type = 'number';
      break;
    case 'date':
      Object.assign(s, { type: 'string', format: 'date' });
      break;
    case 'datetime':
    case 'datetimeoffset':
      Object.assign(s, { type: 'string', format: 'date-time' });
      break;
    case 'time':
      Object.assign(s, { type: 'string', format: 'time' });
      break;
    case 'interval':
      Object.assign(s, { type: 'string', format: 'duration' });
      break;
    case 'guid':
      Object.assign(s, { type: 'string', format: 'uuid' });
      break;
    case 'binary':
    case 'rowversion':
      Object.assign(s, { type: 'string', contentEncoding: 'base64' });
      break;
    case 'json':
    case 'object':
      break;
    default:
      s.type = 'string';
      if (t.length && t.logical === 'string') s.maxLength = t.length;
  }
  if (m.nullable) {
    if (typeof s.type === 'string') s.type = [s.type, 'null'];
  }
  const c = commentText(m.col.comment);
  if (c) s.description = c;
  if (m.col.identity || m.col.computed || t.logical === 'rowversion') s.readOnly = true;
  return s;
}

function columnsOf(obj: CgObject): { name: string; label: string; columns: CgColumn[]; comment?: string | null; singular: boolean } | null {
  if (isTable(obj)) return { name: obj.name, label: objectLabel(obj), columns: obj.columns, comment: obj.comment, singular: true };
  if (obj.kind === 'query') return { name: `${obj.name}_row`, label: obj.name, columns: obj.columns, singular: false };
  if ((obj.kind === 'proc' || obj.kind === 'func') && obj.resultColumns) return { name: `${obj.name}_row`, label: objectLabel(obj), columns: obj.resultColumns, singular: false };
  return null;
}

export function generateJson(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const shapes = input.objects.map(columnsOf).filter((x): x is NonNullable<ReturnType<typeof columnsOf>> => !!x);
  if (!shapes.length) return [];
  if (o.flavor === 'json-schema') {
    const defs: Record<string, unknown> = {};
    for (const s of shapes) {
      const typeName = typeNameOf(s.name, o, s.singular);
      const members = membersOf(s.columns, d, o, typeName);
      defs[typeName] = {
        type: 'object',
        title: typeName,
        ...(commentText(s.comment) ? { description: commentText(s.comment) } : { description: `Row of ${s.label}` }),
        properties: Object.fromEntries(members.map((m) => [m.name, schemaFor(m)])),
        required: members.filter((m) => !m.nullable).map((m) => m.name),
        additionalProperties: false,
      };
    }
    const names = Object.keys(defs);
    const schema =
      names.length === 1
        ? { $schema: 'https://json-schema.org/draft/2020-12/schema', ...(defs[names[0]] as object) }
        : { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: defs };
    return [{ path: names.length === 1 ? `${names[0]}.schema.json` : 'schema.json', language: 'json', content: JSON.stringify(schema, null, 2) + '\n' }];
  }
  const samples: Record<string, unknown> = {};
  for (const s of shapes) {
    const typeName = typeNameOf(s.name, o, s.singular);
    const members = membersOf(s.columns, d, o, typeName);
    samples[typeName] = Object.fromEntries(members.map((m) => [m.name, sampleValue(m.type)]));
  }
  const names = Object.keys(samples);
  const value = names.length === 1 ? samples[names[0]] : samples;
  return [{ path: names.length === 1 ? `${names[0]}.sample.json` : 'samples.json', language: 'json', content: JSON.stringify(value, null, 2) + '\n' }];
}

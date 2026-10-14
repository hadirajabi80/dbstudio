// Single entry point for Monaco in DbStudio: the core editor API plus all editor contributions,
// but none of Monaco's bundled languages (we register our own three SQL dialects).
import 'monaco-editor/features/register.all';

export * from 'monaco-editor/editor/editor.api';

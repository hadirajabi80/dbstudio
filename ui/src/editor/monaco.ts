// Single entry point for Monaco in DbStudio: the core editor API plus all editor contributions,
// but none of Monaco's bundled languages (we register our own three SQL dialects).
import 'monaco-editor/features/register.all';
// DbStudio's IntelliSense widget look (suggest, details, parameter hints, hover): after Monaco's CSS, so it wins.
import './editor-widgets.css';

export * from 'monaco-editor/editor/editor.api';

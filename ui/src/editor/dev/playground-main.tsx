// Stand-alone entry for the editor playground in Vite dev: http://localhost:5173/src/editor/dev/playground.html
import { createRoot } from 'react-dom/client';
import { EditorPlayground } from './EditorPlayground';

createRoot(document.getElementById('root')!).render(<EditorPlayground />);

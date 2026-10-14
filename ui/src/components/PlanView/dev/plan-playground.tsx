// Dev page: http://localhost:5173/src/components/PlanView/dev/plan-playground.html?d=tsql|plsql|sqlite&theme=dark
import { createRoot } from 'react-dom/client';
import type { ExecPlanPayload } from '../../../api/types';
import { applyThemeAttribute, systemTheme } from '../../../theme/useTheme';
import { PlanView } from '../PlanView';
import tsql from '../fixtures/tsql-actual.json';
import plsql from '../fixtures/plsql-estimated.json';
import sqlite from '../../../mocks/fixtures/m15/plans/sqlite-estimated.json';
import '../../../theme/tokens.css';
import '../../../theme/app.css';

const q = new URLSearchParams(location.search);
const plans: Record<string, unknown> = { tsql, plsql, sqlite };
applyThemeAttribute(q.get('theme') === 'dark' ? 'dark' : q.get('theme') === 'light' ? 'light' : systemTheme());
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex' }}>
    <PlanView plan={plans[q.get('d') ?? 'tsql'] as ExecPlanPayload} sql="SELECT …" onRerun={() => undefined} />
  </div>,
);

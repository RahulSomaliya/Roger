import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PromptApp } from './PromptApp';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <PromptApp api={window.rogerPrompt} />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import { createAppTheme } from '@cw/ui';
import { LoginPage } from './LoginPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={createAppTheme()} defaultMode="system">
      <CssBaseline enableColorScheme />
      <LoginPage />
    </ThemeProvider>
  </StrictMode>,
);

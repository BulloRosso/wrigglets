import { createTheme, type Theme } from '@mui/material/styles';

/**
 * One Material Design theme for every UI of the platform (agent UI, admin console, sign-in pages).
 * Light and dark colour schemes; CSS variables so the scheme can follow the OS or a user toggle.
 */
export const brand = {
  primary: { light: '#1f5fad', dark: '#8ab4ff' },
  secondary: { light: '#00796b', dark: '#4fd1c5' },
};

export function createAppTheme(): Theme {
  return createTheme({
    cssVariables: { colorSchemeSelector: 'data-cw-scheme' },
    colorSchemes: {
      light: {
        palette: {
          primary: { main: brand.primary.light },
          secondary: { main: brand.secondary.light },
          background: { default: '#f4f6fa', paper: '#ffffff' },
          success: { main: '#2e7d32' },
          warning: { main: '#b26a00' },
        },
      },
      dark: {
        palette: {
          primary: { main: brand.primary.dark },
          secondary: { main: brand.secondary.dark },
          background: { default: '#0f141b', paper: '#161d27' },
        },
      },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: 'Roboto, "Segoe UI", system-ui, -apple-system, sans-serif',
      h4: { fontWeight: 400, letterSpacing: 0 },
      h5: { fontWeight: 500 },
      h6: { fontWeight: 500 },
      button: { textTransform: 'none', fontWeight: 500, letterSpacing: 0.1 },
      overline: { letterSpacing: 1.2, fontWeight: 500 },
    },
    components: {
      MuiAppBar: { defaultProps: { elevation: 0, color: 'inherit' }, styleOverrides: { root: ({ theme }) => ({ borderBottom: `1px solid ${theme.vars!.palette.divider}` }) } },
      MuiCard: { defaultProps: { variant: 'outlined' } },
      MuiPaper: { styleOverrides: { outlined: { borderRadius: 12 } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
      MuiTableCell: { styleOverrides: { head: { fontWeight: 600, whiteSpace: 'nowrap' } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiSelect: { defaultProps: { size: 'small' } },
    },
  });
}

import { useState, type ReactNode } from 'react';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import { useColorScheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import MenuIcon from '@mui/icons-material/Menu';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import SettingsBrightnessOutlined from '@mui/icons-material/SettingsBrightnessOutlined';
import LogoutOutlined from '@mui/icons-material/LogoutOutlined';
import { Logo } from './Logo';

export interface NavItem {
  label: string;
  icon: ReactNode;
  selected: boolean;
  onClick: () => void;
  badge?: ReactNode;
}

export interface AppShellProps {
  product: string;
  context?: string;
  nav: NavItem[];
  navTitle?: string;
  user?: { name: string; upn: string; roles: string[] };
  actions?: ReactNode;
  children: ReactNode;
  signOutHref?: string;
  /** Replaces the logo in the navigation drawer (e.g. the agent's portrait). */
  avatar?: ReactNode;
}

const DRAWER = 248;

function SchemeToggle() {
  const { mode, setMode } = useColorScheme();
  const next = mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light';
  const icon = mode === 'light' ? <LightModeOutlined /> : mode === 'dark' ? <DarkModeOutlined /> : <SettingsBrightnessOutlined />;
  return (
    <Tooltip title={`Theme: ${mode ?? 'system'} (switch to ${next})`}>
      <IconButton onClick={() => setMode(next)} aria-label="Toggle colour scheme">
        {icon}
      </IconButton>
    </Tooltip>
  );
}

/** Application frame: top app bar, navigation drawer (permanent ≥ md, temporary below), content. */
export function AppShell({ product, context, nav, navTitle, user, actions, children, signOutHref = '/auth/logout', avatar }: AppShellProps) {
  const wide = useMediaQuery((t) => t.breakpoints.up('md'));
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const initials = (user?.name || user?.upn || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');

  const drawer = (
    <Box sx={{ width: DRAWER }} role="navigation">
      <Toolbar sx={{ gap: 1.5 }}>
        {avatar ?? <Logo color="primary" />}
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600, lineHeight: 1.2 }}>
            {product}
          </Typography>
          {context && (
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {context}
            </Typography>
          )}
        </Box>
      </Toolbar>
      <Divider />
      <List subheader={navTitle ? <ListSubheader sx={{ bgcolor: 'transparent' }}>{navTitle}</ListSubheader> : undefined} sx={{ px: 1 }}>
        {nav.map((item) => (
          <ListItemButton
            key={item.label}
            selected={item.selected}
            onClick={() => {
              item.onClick();
              setOpen(false);
            }}
            sx={{ borderRadius: 2, mb: 0.5 }}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} />
            {item.badge}
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="fixed" sx={{ width: { md: `calc(100% - ${DRAWER}px)` }, ml: { md: `${DRAWER}px` }, bgcolor: 'background.paper' }}>
        <Toolbar sx={{ gap: 1 }}>
          {!wide && (
            <IconButton edge="start" onClick={() => setOpen(true)} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          {!wide && (
            <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600 }}>
              {product}
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          {actions}
          <SchemeToggle />
          {user && (
            <>
              <Tooltip title={`Signed in as ${user.upn}`}>
                <IconButton onClick={(e) => setMenu(e.currentTarget)} aria-label="Account">
                  <Avatar sx={{ width: 32, height: 32, fontSize: 14, bgcolor: 'primary.main' }}>{initials}</Avatar>
                </IconButton>
              </Tooltip>
              <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
                <Box sx={{ px: 2, py: 1, maxWidth: 320 }}>
                  <Typography variant="subtitle2">{user.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Signed in as {user.upn}
                  </Typography>
                  <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
                    {user.roles.map((r) => (
                      <Chip key={r} label={r} size="small" variant="outlined" />
                    ))}
                  </Stack>
                </Box>
                <Divider />
                <MenuItem component="a" href={signOutHref}>
                  <ListItemIcon>
                    <LogoutOutlined fontSize="small" />
                  </ListItemIcon>
                  Sign out
                </MenuItem>
              </Menu>
            </>
          )}
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { md: DRAWER }, flexShrink: { md: 0 } }}>
        {wide ? (
          <Drawer variant="permanent" open slotProps={{ paper: { sx: { width: DRAWER } } }}>
            {drawer}
          </Drawer>
        ) : (
          <Drawer variant="temporary" open={open} onClose={() => setOpen(false)} ModalProps={{ keepMounted: true }}>
            {drawer}
          </Drawer>
        )}
      </Box>
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, sm: 3 }, pt: { xs: 10, sm: 11 } }}>
        {children}
      </Box>
    </Box>
  );
}

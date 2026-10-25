import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';

/** Brand mark: three interlocking cells (people + agent working on one shared data set). */
export function Logo(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.8 3.8L12 11.9 5.2 8.1 12 4.3ZM5 9.8l6 3.4v6.6l-6-3.4V9.8Zm8 10V13.2l6-3.4v6.6l-6 3.4Z" />
    </SvgIcon>
  );
}

import * as React from 'react';

/**
 * The dashboard's tablet/narrow band is `≤980px`, and that is where the spec
 * hands primary navigation to the sidebar provider's mobile sheet. Upstream's
 * block defaults to `768px`, which would keep the desktop rail on a 900px
 * screen the spec calls a sheet.
 */
const MOBILE_MAX_WIDTH_PX = 980;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH_PX}px)`);
    const onChange = () => {
      setIsMobile(mql.matches);
    };
    mql.addEventListener('change', onChange);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return !!isMobile;
}

import { mergeConfig } from 'vite';

import webConfig from '../../vite.config';

export default mergeConfig(webConfig, {
  server: { host: '127.0.0.1', port: 4175, strictPort: true, open: false },
});

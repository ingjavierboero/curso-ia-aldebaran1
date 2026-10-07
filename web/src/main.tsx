import { App as AntApp, ConfigProvider } from 'antd';
import esES from 'antd/locale/es_ES';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={esES} theme={{ token: { colorPrimary: '#1f4e79', borderRadius: 8 } }}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);

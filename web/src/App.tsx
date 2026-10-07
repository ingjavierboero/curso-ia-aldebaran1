import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Layout, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useEffect } from 'react';
import styled from 'styled-components';
import { InvoiceCard } from './components/InvoiceCard';
import { type StatusFilter, useReviewStore, visibleInvoices } from './store';

const Page = styled.main`
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px 48px;
`;

const Header = styled(Layout.Header)`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
`;

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
`;

export function App() {
  const { invoices, loading, error, filter, load, setFilter } = useReviewStore();
  const shown = visibleInvoices(invoices, filter);
  const count = (status: StatusFilter) => visibleInvoices(invoices, status).length;

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header>
        <Typography.Title level={4} style={{ color: 'white', margin: 0 }}>
          Aldebaran
        </Typography.Title>
        <Tag color="gold">Homologación ARCA</Tag>
      </Header>
      <Page>
        <Typography.Title level={2}>Revisión de pagos</Typography.Title>
        <Typography.Paragraph type="secondary">
          Facturas con un comprobante recibido. Confirmá el pago para pasarlas a Pagada, o devolvelas a Pendiente de pago
          si el pago no se realizó.
        </Typography.Paragraph>

        <Toolbar>
          <Segmented<StatusFilter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `Todas (${count('all')})` },
              { value: 'payment_received', label: `Pago recibido (${count('payment_received')})` },
              { value: 'manual_review', label: `Revisión manual (${count('manual_review')})` },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            Actualizar
          </Button>
        </Toolbar>

        {error && (
          <Alert
            type="error"
            showIcon
            message="No se pudieron cargar las facturas"
            description={error}
            action={<Button onClick={() => void load()}>Reintentar</Button>}
            style={{ marginBottom: 16 }}
          />
        )}

        <Spin spinning={loading && invoices.length === 0}>
          {shown.length === 0 && !loading && !error ? (
            <Empty description="No hay pagos para revisar" style={{ padding: 48 }} />
          ) : (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {shown.map((invoice) => (
                <InvoiceCard key={invoice.id} invoice={invoice} />
              ))}
            </Space>
          )}
        </Spin>
      </Page>
    </Layout>
  );
}

import { CheckOutlined, FilePdfOutlined, RollbackOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Popconfirm, Space, Tag, Typography } from 'antd';
import { api } from '../api';
import { formatArs, formatCuit, formatDate, formatDateTime, formatInvoiceNumber, formatPeriod } from '../format';
import { useReviewStore } from '../store';
import type { ReviewInvoice } from '../types';
import { PaymentEmail } from './PaymentEmail';

export const STATUS = {
  payment_received: { color: 'green', label: 'Pago recibido' },
  manual_review: { color: 'orange', label: 'Revisión manual' },
} as const;

export function InvoiceCard({ invoice }: { invoice: ReviewInvoice }) {
  const { message } = App.useApp();
  const acting = useReviewStore((s) => !!s.acting[invoice.id]);
  const confirmPayment = useReviewStore((s) => s.confirmPayment);
  const rejectPayment = useReviewStore((s) => s.rejectPayment);
  const number = formatInvoiceNumber(invoice.pointOfSale, invoice.number);

  const run = async (action: (id: number) => Promise<string | null>, success: string) => {
    const error = await action(invoice.id);
    if (error) message.error(error);
    else message.success(success);
  };

  return (
    <Card
      title={
        <Space wrap>
          <span>{invoice.client.businessName}</span>
          <Tag color={STATUS[invoice.status].color}>{STATUS[invoice.status].label}</Tag>
        </Space>
      }
      extra={
        <a href={api.invoicePdfUrl(invoice.id)} target="_blank" rel="noreferrer">
          <FilePdfOutlined /> Ver factura
        </a>
      }
    >
      {invoice.status === 'manual_review' && invoice.reviewReason && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Motivo: ${invoice.reviewReason}`}
        />
      )}

      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Factura C">{number}</Descriptions.Item>
        <Descriptions.Item label="Período">{formatPeriod(invoice.period)}</Descriptions.Item>
        <Descriptions.Item label="Total">
          <Typography.Text strong>{formatArs(invoice.totalCents)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="Vencimiento">{formatDate(invoice.paymentDueDate)}</Descriptions.Item>
        <Descriptions.Item label="CUIT del cliente">{formatCuit(invoice.client.cuit)}</Descriptions.Item>
        <Descriptions.Item label="En revisión desde">{formatDateTime(invoice.statusChangedAt)}</Descriptions.Item>
      </Descriptions>

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Comprobantes recibidos
      </Typography.Title>
      <Space direction="vertical" style={{ width: '100%' }}>
        {invoice.emails.length === 0 ? (
          <Typography.Text type="secondary">No hay comprobantes asociados.</Typography.Text>
        ) : (
          invoice.emails.map((email) => <PaymentEmail key={email.id} email={email} clientCuit={invoice.client.cuit} />)
        )}
      </Space>

      <Space wrap style={{ marginTop: 16 }}>
        <Popconfirm
          title="¿Confirmar el pago?"
          description={`La factura ${number} pasa a Pagada.`}
          okText="Confirmar pago"
          cancelText="Cancelar"
          onConfirm={() => run(confirmPayment, `Factura ${number} pagada`)}
        >
          <Button type="primary" icon={<CheckOutlined />} loading={acting}>
            Confirmar pago
          </Button>
        </Popconfirm>
        <Popconfirm
          title="¿El pago no se realizó?"
          description={`La factura ${number} vuelve a Pendiente de pago.`}
          okText="Devolver a pendiente"
          cancelText="Cancelar"
          onConfirm={() => run(rejectPayment, `Factura ${number} devuelta a Pendiente de pago`)}
        >
          <Button icon={<RollbackOutlined />} disabled={acting}>
            Devolver a pendiente
          </Button>
        </Popconfirm>
      </Space>
    </Card>
  );
}

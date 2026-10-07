import { CheckCircleFilled, CloseCircleFilled, PaperClipOutlined, WarningFilled } from '@ant-design/icons';
import { Space, Tag, Typography } from 'antd';
import styled from 'styled-components';
import { api } from '../api';
import { formatArs, formatCuit, formatDateTime, formatSize } from '../format';
import type { ReviewEmail } from '../types';

const Box = styled.div`
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 12px 14px;
  background: #fafafa;
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 4px 12px;
  margin-top: 8px;
  font-size: 13px;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
`;

const CLASSIFICATION = {
  si: { color: 'green', label: 'Es un pago' },
  no: { color: 'default', label: 'No es un pago' },
  dudoso: { color: 'orange', label: 'Dudoso' },
} as const;

interface Props {
  email: ReviewEmail;
  clientCuit: string;
}

/** Un comprobante recibido: lo que leyó el LLM, comparado con los datos del cliente. */
export function PaymentEmail({ email, clientCuit }: Props) {
  const cuitMatches = email.extractedCuit === clientCuit;

  return (
    <Box>
      <Space wrap size={8}>
        <Typography.Text strong>{email.subject || '(sin asunto)'}</Typography.Text>
        {email.processingStatus === 'error' ? (
          <Tag color="red">No se pudo procesar</Tag>
        ) : email.classification ? (
          <Tag color={CLASSIFICATION[email.classification].color}>{CLASSIFICATION[email.classification].label}</Tag>
        ) : null}
      </Space>
      <div>
        <Typography.Text type="secondary">
          {email.from} · {formatDateTime(email.receivedAt)}
        </Typography.Text>
      </div>

      <Row>
        {email.processingStatus === 'error' && (
          <>
            <Typography.Text type="secondary">Error</Typography.Text>
            <Typography.Text type="danger">{email.processingError}</Typography.Text>
          </>
        )}
        {email.classification === 'si' && (
          <>
            <Typography.Text type="secondary">CUIT del pagador</Typography.Text>
            <span>
              {email.extractedCuit ? (
                <Space size={6}>
                  {formatCuit(email.extractedCuit)}
                  {cuitMatches ? (
                    <Typography.Text type="success">
                      <CheckCircleFilled /> coincide con el cliente
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="danger">
                      <CloseCircleFilled /> no coincide con el cliente
                    </Typography.Text>
                  )}
                </Space>
              ) : (
                <Typography.Text type="warning">
                  <WarningFilled /> no se pudo leer
                </Typography.Text>
              )}
            </span>
            <Typography.Text type="secondary">Monto pagado</Typography.Text>
            <span>
              {email.extractedAmountCents !== null ? (
                <Typography.Text strong>{formatArs(email.extractedAmountCents)}</Typography.Text>
              ) : (
                <Typography.Text type="warning">
                  <WarningFilled /> no se pudo leer
                </Typography.Text>
              )}
            </span>
          </>
        )}
        <Typography.Text type="secondary">Adjuntos</Typography.Text>
        <Space direction="vertical" size={2}>
          {email.attachments.map((a) => (
            <a key={a.id} href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer">
              <PaperClipOutlined /> {a.filename} <Typography.Text type="secondary">({formatSize(a.sizeBytes)})</Typography.Text>
            </a>
          ))}
        </Space>
      </Row>
    </Box>
  );
}

'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, Checkbox, Form, Input, Select, Skeleton, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { useFeedback } from '../../components/feedback';
import { icons } from '../../theme/icons';
import { fontSize } from '../../theme/tokens';
import { espacesApi, type GedSpaceSummary } from '../../lib/espaces';
import { editeurApi } from '../../lib/editeur';

const { Text } = Typography;

interface FormValues {
  spaceId: number;
  label?: string;
  withImport?: boolean;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function NouveauDocumentForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { message } = useFeedback();
  const [form] = Form.useForm<FormValues>();
  const [spaces, setSpaces] = useState<GedSpaceSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const withImport = Form.useWatch('withImport', form);

  const preselected = Number(params.get('spaceId'));

  useEffect(() => {
    let alive = true;
    espacesApi
      .list()
      .then((list) => {
        if (!alive) return;
        const active = list.filter((s) => s.isActive);
        setSpaces(active);
        // Pré-sélection : seulement si l'espace existe, est actif et accepte une contribution.
        const pre = active.find((s) => s.gedSpaceId === preselected && s.myAccess !== 0);
        if (pre) form.setFieldValue('spaceId', pre.gedSpaceId);
      })
      .catch((e) => alive && setLoadError(errMsg(e, 'Chargement des espaces impossible.')));
    return () => {
      alive = false;
    };
  }, [form, preselected]);

  const options = useMemo(
    () =>
      (spaces ?? []).map((s) => ({
        value: s.gedSpaceId,
        // myAccess 0 = Lecture : on ne propose pas ce que le serveur refusera.
        disabled: s.myAccess === 0,
        label: s.myAccess === 0 ? `${s.label} (lecture seule)` : s.label,
      })),
    [spaces],
  );

  const onFinish = async (v: FormValues) => {
    setFormError(null);
    const file = files[0]?.originFileObj;
    if (v.withImport && !file) {
      setFormError('Choisissez le fichier DOCX à importer, ou décochez l’option.');
      return;
    }
    if (!v.withImport && !v.label?.trim()) {
      setFormError('Saisissez un titre.');
      return;
    }
    setSubmitting(true);
    try {
      const created =
        v.withImport && file
          ? await editeurApi.importAsNew(file, v.spaceId, v.label)
          : await editeurApi.createDocument(v.spaceId, v.label!.trim());
      created.warnings.slice(0, 5).forEach((w) => message.warning(w));
      router.push(`/editeur/${created.documentId}`);
    } catch (e) {
      setFormError(errMsg(e, 'Création impossible.'));
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon="document"
        title="Nouveau document"
        breadcrumb={[{ label: 'Espaces', href: '/espaces' }, { label: 'Nouveau document' }]}
        actions={<Button onClick={() => router.back()}>Annuler</Button>}
      />
      <Card style={{ maxWidth: 640 }}>
        {loadError ? (
          <Alert type="error" showIcon message={loadError} />
        ) : spaces === null ? (
          <div aria-busy="true" aria-label="Chargement des espaces">
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
        ) : (
          <Form<FormValues> form={form} layout="vertical" requiredMark={false} onFinish={onFinish}>
            <Form.Item
              name="spaceId"
              label="Espace"
              rules={[{ required: true, message: 'Choisissez un espace.' }]}
            >
              <Select
                options={options}
                placeholder="Choisir un espace"
                showSearch
                optionFilterProp="label"
                notFoundContent="Aucun espace disponible"
              />
            </Form.Item>
            <Form.Item
              name="label"
              label={withImport ? 'Titre (facultatif : le nom du fichier est repris)' : 'Titre'}
            >
              <Input maxLength={200} placeholder="Ex. : Compte rendu du comité" />
            </Form.Item>
            <Form.Item name="withImport" valuePropName="checked">
              <Checkbox>Importer un DOCX</Checkbox>
            </Form.Item>
            {withImport && (
              <Form.Item label="Fichier DOCX">
                <Upload
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  maxCount={1}
                  fileList={files}
                  beforeUpload={() => false}
                  onChange={({ fileList }) => setFiles(fileList.slice(-1))}
                >
                  <Button icon={<icons.upload size={16} />}>Choisir un fichier</Button>
                </Upload>
              </Form.Item>
            )}
            {formError && (
              <Alert type="error" showIcon message={formError} style={{ marginBottom: 16 }} role="alert" />
            )}
            <Button type="primary" htmlType="submit" loading={submitting}>
              Créer le document
            </Button>
            <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: fontSize.xs }}>
              Le document est créé dans l’espace choisi, puis ouvert dans l’éditeur.
            </Text>
          </Form>
        )}
      </Card>
    </div>
  );
}

export default function NouveauDocumentPage() {
  // useSearchParams impose une frontière Suspense pour le rendu statique de Next.
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 4 }} />}>
      <NouveauDocumentForm />
    </Suspense>
  );
}

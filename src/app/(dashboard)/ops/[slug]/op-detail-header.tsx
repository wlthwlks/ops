"use client";

import { Card, Descriptions, Typography } from "antd";
import { RunButton } from "../run-button";
import { OperationRiskTag } from "@/components/ops/OperationRiskTag";

const { Title } = Typography;

export function OpDetailHeader(props: {
  name: string;
  description: string;
  slug: string;
  riskLevel?: string;
  cliOnly?: boolean;
  commandEquivalent?: string;
  whenToRun?: string;
  whenNotToRun?: string;
}) {
  return (
    <>
      <Title level={3}>{props.name}</Title>
      <Card size="small" style={{ marginBottom: 24 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="Slug">{props.slug}</Descriptions.Item>
          <Descriptions.Item label="Description">
            {props.description || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Risk">
            <OperationRiskTag risk={props.riskLevel} />
          </Descriptions.Item>
          {props.commandEquivalent && (
            <Descriptions.Item label="CLI">
              <Typography.Text code>{props.commandEquivalent}</Typography.Text>
            </Descriptions.Item>
          )}
          {props.whenToRun && (
            <Descriptions.Item label="When to run">{props.whenToRun}</Descriptions.Item>
          )}
          {props.whenNotToRun && (
            <Descriptions.Item label="When not to run">
              {props.whenNotToRun}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Run">
            <RunButton
              slug={props.slug}
              disabled={Boolean(props.cliOnly)}
              cliOnly={props.cliOnly}
              commandEquivalent={props.commandEquivalent}
            />
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Title level={5} style={{ marginTop: 8 }}>
        Recent runs
      </Title>
    </>
  );
}

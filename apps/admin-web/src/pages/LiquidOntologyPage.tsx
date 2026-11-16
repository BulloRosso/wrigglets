import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useColorScheme } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import KeyOutlined from "@mui/icons-material/KeyOutlined";
import { ConfirmDialog, ErrorAlert, Loading, PageHeader } from "@cw/ui";
import {
  filterGraph,
  irToGraph,
  type OntologyIr,
} from "@cw/ontology-ir/browser";
import { api, type OntologyDraft } from "../api";
import { DraftPanel } from "../components/ontology/DraftPanel";
import {
  ClassNode,
  CRITICALITY_COLOR,
  type ClassChange,
  type ClassFlowNode,
} from "../components/ontology/ClassNode";
import {
  autoLayout,
  clearPositions,
  loadPositions,
  savePositions,
} from "../components/ontology/layout";

/*
 * Ontology editor, track E1 (ADR-0042): the compiled ontology as a graph — classes as nodes, links as edges — with a
 * side panel for attributes, links, actions, bindings and enums. E2: "Edit as draft" forks the ontology files from the
 * config repository; typed operations, compiled on every change, diff colours; submit = a config proposal (E3).
 */

const nodeTypes = { class: ClassNode };

export function Detail({
  ir,
  id,
  onSelect,
  onClose,
}: {
  ir: OntologyIr;
  id: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const c = ir.classes.find((x) => x.name === id)!;
  const binding = ir.bindings.find((b) => b.class === id);
  const incoming = ir.links.filter((l) => l.to === id);
  const actions = ir.actions.filter((a) => a.target === id);
  const events = ir.events.filter((e) => e.objectType === id);
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ alignItems: "center" }}>
        <Typography variant="h6" sx={{ flex: 1 }}>
          {c.name}
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close details">
          <CloseOutlined fontSize="small" />
        </IconButton>
      </Stack>
      {c.description && (
        <Typography variant="body2" color="text.secondary">
          {c.description}
        </Typography>
      )}
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ flexWrap: "wrap", rowGap: 0.5 }}
      >
        <Chip
          size="small"
          color={CRITICALITY_COLOR[c.annotations.criticality]}
          label={c.annotations.criticality}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`data: ${c.annotations.data_class}`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`owner: ${c.annotations.owner}`}
        />
        {c.annotations.mcp_group && (
          <Chip
            size="small"
            variant="outlined"
            label={`group: ${c.annotations.mcp_group}`}
          />
        )}
      </Stack>
      <Typography variant="overline">Attributes</Typography>
      <Table size="small">
        <TableBody>
          {c.attributes.map((a) => (
            <TableRow key={a.name}>
              <TableCell
                sx={{
                  py: 0.4,
                  pl: 0,
                  fontFamily: "monospace",
                  fontWeight: a.required ? 600 : 400,
                }}
              >
                {a.identifier && (
                  <KeyOutlined
                    sx={{
                      fontSize: 12,
                      mr: 0.5,
                      color: "warning.main",
                      verticalAlign: "middle",
                    }}
                  />
                )}
                {a.name}
              </TableCell>
              <TableCell sx={{ py: 0.4, fontFamily: "monospace" }}>
                {a.rangeKind === "class" ? (
                  <Button
                    size="small"
                    sx={{
                      p: 0,
                      minWidth: 0,
                      textTransform: "none",
                      fontFamily: "monospace",
                    }}
                    onClick={() => onSelect(a.range)}
                  >
                    → {a.range}
                    {a.multivalued ? "[]" : ""}
                  </Button>
                ) : (
                  <Tooltip title={a.description ?? ""}>
                    <span>
                      {a.range}
                      {a.multivalued ? "[]" : ""}
                    </span>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell sx={{ py: 0.4, pr: 0 }} align="right">
                {a.required ? (
                  <Typography variant="caption">required</Typography>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    optional
                  </Typography>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {incoming.length > 0 && (
        <>
          <Typography variant="overline">Referenced by</Typography>
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ flexWrap: "wrap", rowGap: 0.5 }}
          >
            {incoming.map((l) => (
              <Chip
                key={`${l.from}.${l.attribute}`}
                size="small"
                variant="outlined"
                label={`${l.from}.${l.attribute}`}
                onClick={() => onSelect(l.from)}
              />
            ))}
          </Stack>
        </>
      )}
      <Typography variant="overline">Actions ({actions.length})</Typography>
      {actions.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          none
        </Typography>
      )}
      {actions.map((a) => (
        <Box key={a.name}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Typography
              variant="body2"
              sx={{ fontFamily: "monospace", fontWeight: 600 }}
            >
              {a.name}
            </Typography>
            <Chip
              size="small"
              label={a.kind}
              sx={{ height: 18, fontSize: 10 }}
              color={a.readOnly ? "default" : "primary"}
            />
            {a.destructive && (
              <Chip
                size="small"
                color="error"
                label="destructive"
                sx={{ height: 18, fontSize: 10 }}
              />
            )}
          </Stack>
          {(a.preconditions.length > 0 || a.emits.length > 0) && (
            <Typography variant="caption" color="text.secondary">
              {a.preconditions.length > 0 &&
                `checks: ${a.preconditions.join(", ")}`}
              {a.preconditions.length > 0 && a.emits.length > 0 && " · "}
              {a.emits.length > 0 && `emits: ${a.emits.join(", ")}`}
            </Typography>
          )}
        </Box>
      ))}
      {events.length > 0 && (
        <>
          <Typography variant="overline">Events</Typography>
          <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
            {events.map((e) => e.name).join(", ")}
          </Typography>
        </>
      )}
      <Typography variant="overline">Source data</Typography>
      {binding ? (
        <Typography variant="body2">
          <code>lake.raw.{binding.table}</code> · key {binding.key.join(", ")}
          {Object.entries(binding.columns).filter(([a, col]) => a !== col)
            .length > 0 && (
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ display: "block" }}
            >
              {Object.entries(binding.columns)
                .filter(([a, col]) => a !== col)
                .map(([a, col]) => `${a} ← ${col}`)
                .join(" · ")}
            </Typography>
          )}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          no raw table: objects exist only through actions
        </Typography>
      )}
    </Stack>
  );
}

function Summary({ ir }: { ir: OntologyIr }) {
  const graph = irToGraph(ir);
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">{ir.title ?? ir.name}</Typography>
      {ir.description && (
        <Typography variant="body2" color="text.secondary">
          {ir.description}
        </Typography>
      )}
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ flexWrap: "wrap", rowGap: 0.5 }}
      >
        <Chip size="small" label={`${ir.name}@${ir.version}`} />
        <Chip
          size="small"
          variant="outlined"
          label={`hash ${ir.hash.slice(0, 12)}`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${ir.classes.length} classes`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${ir.links.length} links`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${ir.actions.length} actions`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${ir.events.length} events`}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Select a class to see its attributes, links, actions and source table.
        Drag nodes to arrange them; the layout is remembered in this browser.
      </Typography>
      <Divider />
      <Typography variant="overline">Company-wide actions</Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
        {graph.globalActions.map((a) => a.name).join(", ")}
      </Typography>
      <Typography variant="overline">Enums ({ir.enums.length})</Typography>
      {ir.enums.map((e) => (
        <Box key={e.name}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 600, fontFamily: "monospace" }}
          >
            {e.name}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: "monospace" }}
          >
            {e.values.map((v) => v.value).join(" · ")}
          </Typography>
        </Box>
      ))}
      <Divider />
      <Typography variant="caption" color="text.secondary">
        Source: <code>ontology/{ir.name}/*.yaml</code>, compiled with LinkML
        (see docs/link-ml.md). Editing in the graph follows with drafts and
        proposals.
      </Typography>
    </Stack>
  );
}

export interface CanvasProps {
  ir: OntologyIr;
  /** Diff colouring per class (E2 drafts, E3 proposals). */
  changes?: Record<string, ClassChange>;
  /** Drag from one class to another = new link (draft mode). */
  onConnect?: (from: string, to: string) => void;
  /** Replaces the summary in the side panel (e.g. the draft panel); gets the selected class. */
  side?: (
    selected: string | undefined,
    select: (id: string | undefined) => void,
  ) => ReactNode;
  height?: string;
  /** Zoom to these classes and their neighbours once (e.g. the changed classes of a proposal). */
  focus?: string[];
  /** No side panel (embedded diff graph). */
  bare?: boolean;
}

export function Canvas({
  ir,
  changes,
  onConnect,
  side,
  height,
  focus,
  bare,
}: CanvasProps) {
  const { mode, systemMode } = useColorScheme();
  const graph = useMemo(() => irToGraph(ir), [ir]);
  const [text, setText] = useState("");
  const [group, setGroup] = useState("");
  const [criticality, setCriticality] = useState("");
  const [selected, setSelected] = useState<string | undefined>();
  const [nodes, setNodes] = useState<ClassFlowNode[]>([]);
  const flow = useReactFlow();
  // Selecting a class zooms to it and the classes it is linked with (both directions).
  useEffect(() => {
    if (!selected) return;
    const near = new Set([
      selected,
      ...graph.edges.filter((e) => e.source === selected).map((e) => e.target),
      ...graph.edges.filter((e) => e.target === selected).map((e) => e.source),
    ]);
    void flow.fitView({
      nodes: [...near].map((id) => ({ id })),
      duration: 400,
      padding: 0.25,
      maxZoom: 1.1,
    });
  }, [selected, graph, flow]);
  const focusKey = (focus ?? []).join(",");
  useEffect(() => {
    if (!focusKey || !nodes.length) return;
    const f = focusKey.split(",");
    const near = new Set([
      ...f,
      ...graph.edges.filter((e) => f.includes(e.source)).map((e) => e.target),
      ...graph.edges.filter((e) => f.includes(e.target)).map((e) => e.source),
    ]);
    const t = setTimeout(
      () =>
        void flow.fitView({
          nodes: [...near]
            .filter((id) => graph.nodes.some((n) => n.id === id))
            .map((id) => ({ id })),
          duration: 300,
          padding: 0.2,
          maxZoom: 1.1,
        }),
      150,
    );
    return () => clearTimeout(t);
    // once per focus set and graph
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, graph, nodes.length > 0]);
  const all = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const match = useMemo(
    () =>
      filterGraph(graph, {
        text,
        group: group || undefined,
        criticality: criticality || undefined,
      }),
    [graph, text, group, criticality],
  );
  const filtered = !!(text || group || criticality);

  const build = useCallback(
    (reset = false) => {
      if (reset) clearPositions(graph.name);
      const auto = autoLayout(graph, all);
      const saved = reset ? {} : loadPositions(graph.name);
      setNodes(
        graph.nodes.map((n) => ({
          id: n.id,
          type: "class",
          position: saved[n.id] ?? auto[n.id] ?? { x: 0, y: 0 },
          data: { ...n, dimmed: false, selected: false },
        })),
      );
    },
    [graph, all],
  );
  useEffect(() => build(), [build]);

  const shown = nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      dimmed: filtered && !match.has(n.id),
      selected: n.id === selected,
      change: changes?.[n.id],
    },
  }));
  const edges: Edge[] = graph.edges.map((e) => {
    const active = !filtered || (match.has(e.source) && match.has(e.target));
    const hot = selected && (e.source === selected || e.target === selected);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: !!hot,
      style: {
        strokeWidth: hot ? 2.2 : 1.3,
        strokeDasharray: e.required ? undefined : "5 4",
        opacity: active ? 1 : 0.15,
      },
      labelStyle: { fontSize: 10, opacity: active ? 1 : 0.2 },
      labelBgStyle: { fillOpacity: 0.85 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    };
  });

  const onNodesChange = (changes: NodeChange<ClassFlowNode>[]) => {
    setNodes((ns) => {
      const next = applyNodeChanges(changes, ns);
      if (changes.some((c) => c.type === "position" && !c.dragging))
        savePositions(
          graph.name,
          Object.fromEntries(next.map((n) => [n.id, n.position])),
        );
      return next;
    });
  };

  return (
    <Box
      sx={{
        display: "flex",
        gap: 2,
        height: { xs: "auto", md: height ?? "calc(100vh - 210px)" },
        flexDirection: { xs: "column", md: "row" },
      }}
    >
      <Card
        variant="outlined"
        sx={{
          flex: 1,
          minHeight: 480,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ p: 1.5, borderBottom: 1, borderColor: "divider" }}
        >
          <TextField
            size="small"
            label="Search classes, fields, actions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            select
            label="Group"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            sx={{ minWidth: 120 }}
          >
            <MenuItem value="">all</MenuItem>
            {[...new Set(graph.nodes.map((n) => n.group).filter(Boolean))].map(
              (g) => (
                <MenuItem key={g} value={g}>
                  {g}
                </MenuItem>
              ),
            )}
          </TextField>
          <TextField
            size="small"
            select
            label="Criticality"
            value={criticality}
            onChange={(e) => setCriticality(e.target.value)}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">all</MenuItem>
            <MenuItem value="payment_critical">payment critical</MenuItem>
            <MenuItem value="business_critical">business critical</MenuItem>
            <MenuItem value="normal">normal</MenuItem>
          </TextField>
          <Button onClick={() => build(true)}>Reset layout</Button>
        </Stack>
        <Box sx={{ flex: 1, minHeight: 420 }}>
          <ReactFlow
            nodes={shown}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_e, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(undefined)}
            colorMode={
              (mode === "system" ? systemMode : mode) === "dark"
                ? "dark"
                : "light"
            }
            nodesConnectable={!!onConnect}
            onConnect={(c) =>
              c.source && c.target && onConnect?.(c.source, c.target)
            }
            edgesFocusable={false}
            fitView
            fitViewOptions={{ padding: 0.1 }}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>
        </Box>
      </Card>
      {!bare && (
        <Card
          variant="outlined"
          sx={{ width: { xs: "100%", md: 380 }, overflow: "auto" }}
        >
          <CardContent>
            {side ? (
              side(selected, setSelected)
            ) : selected ? (
              <Detail
                ir={ir}
                id={selected}
                onSelect={setSelected}
                onClose={() => setSelected(undefined)}
              />
            ) : (
              <Summary ir={ir} />
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}

function DraftEditor({ draftId }: { draftId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const draft = useQuery({
    queryKey: ["ontology-draft", draftId],
    queryFn: () => api.ontologyDraft(draftId),
  });
  const validation = useQuery({
    queryKey: ["ontology-draft-validation", draftId, draft.data?.ops.length],
    queryFn: () => api.validateDraft(draftId),
    enabled: !!draft.data,
  });
  const [linkFrom, setLinkFrom] = useState<
    { from: string; to: string; attribute: string } | undefined
  >();
  const refresh = (d: OntologyDraft) =>
    qc.setQueryData(["ontology-draft", draftId], d);
  const ops = useMutation({
    mutationFn: (o: Array<Record<string, unknown>>) =>
      api.applyDraftOps(draftId, o),
    onSuccess: refresh,
  });
  const submit = useMutation({
    mutationFn: (v: { title: string; reason: string }) =>
      api.submitDraft(draftId, v.title, v.reason),
    onSuccess: (p) => navigate(`/liquid/proposals/${p.id}`),
  });
  const discard = useMutation({
    mutationFn: () => api.deleteDraft(draftId),
    onSuccess: () => navigate("/liquid/ontology"),
  });
  const ir =
    validation.data?.ir ??
    (qc.getQueryData(["liquid-ontology"]) as OntologyIr | undefined);
  if (draft.isLoading || !ir) return <Loading />;
  if (!draft.data)
    return <ErrorAlert error={draft.error} title="Could not load the draft" />;
  return (
    <>
      <ReactFlowProvider>
        <Canvas
          ir={ir}
          changes={validation.data?.diff?.classes}
          focus={Object.keys(validation.data?.diff?.classes ?? {})}
          onConnect={
            draft.data.proposal
              ? undefined
              : (from, to) =>
                  setLinkFrom({
                    from,
                    to,
                    attribute: to
                      .replace(
                        /(^|[a-z])([A-Z])/g,
                        (_m, a: string, b: string) => (a ? `${a}_${b}` : b),
                      )
                      .toLowerCase(),
                  })
          }
          side={(selected) => (
            <DraftPanel
              draft={draft.data!}
              ir={ir}
              validation={validation.data}
              selected={selected}
              busy={ops.isPending || submit.isPending || validation.isFetching}
              error={ops.error ?? submit.error ?? validation.error}
              onOps={(o) => ops.mutate(o)}
              onSubmit={(title, reason) => submit.mutate({ title, reason })}
              onDiscard={() => discard.mutate()}
            />
          )}
        />
      </ReactFlowProvider>
      <ConfirmDialog
        open={!!linkFrom}
        title={`Link ${linkFrom?.from} → ${linkFrom?.to}`}
        text="A link is an attribute whose range is the other class."
        confirmLabel="Add link"
        busy={ops.isPending}
        onConfirm={() => {
          if (linkFrom)
            ops.mutate([
              {
                op: "add_link",
                from: linkFrom.from,
                attribute: linkFrom.attribute,
                to: linkFrom.to,
              },
            ]);
          setLinkFrom(undefined);
        }}
        onClose={() => setLinkFrom(undefined)}
      >
        <TextField
          sx={{ mt: 1 }}
          fullWidth
          size="small"
          label="Attribute name (snake_case)"
          value={linkFrom?.attribute ?? ""}
          onChange={(e) =>
            linkFrom && setLinkFrom({ ...linkFrom, attribute: e.target.value })
          }
        />
      </ConfirmDialog>
    </>
  );
}

export function LiquidOntologyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const draftId = params.get("draft");
  const ir = useQuery({
    queryKey: ["liquid-ontology"],
    queryFn: api.liquidOntology,
    staleTime: 60_000,
  });
  const create = useMutation({
    mutationFn: () => api.createOntologyDraft("sofa"),
    onSuccess: (d) => navigate(`/liquid/ontology?draft=${d.id}`),
  });
  return (
    <>
      <PageHeader
        overline="Liquid enterprise"
        title={draftId ? "Ontology — draft" : "Ontology"}
        subtitle={
          draftId
            ? "Change the ontology in a draft: every change is compiled; submit it as a proposal for the owners to approve."
            : "The meaning of the business data: classes, links and the typed actions that are the only way to change them."
        }
        actions={
          draftId ? (
            <Button onClick={() => navigate("/liquid/ontology")}>
              Back to the live ontology
            </Button>
          ) : (
            <Button
              variant="contained"
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              Edit as draft
            </Button>
          )
        }
      />
      <ErrorAlert error={create.error} title="Could not create a draft" />
      {ir.isLoading && <Loading />}
      <ErrorAlert error={ir.error} title="Could not load the ontology" />
      {draftId ? (
        <DraftEditor draftId={draftId} />
      ) : (
        ir.data && (
          <ReactFlowProvider>
            <Canvas ir={ir.data} />
          </ReactFlowProvider>
        )
      )}
    </>
  );
}

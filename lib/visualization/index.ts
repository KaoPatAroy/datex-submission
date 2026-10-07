export { compileArtifactRenderer, effectiveInteraction } from './compile';
export type { VisualTraits } from './compile';
export { visualizationPlanSchema, interactionSpecSchema, animationSpecSchema, visualExpressionSchema, VISUAL_LIMITS, VISUAL_PRIMITIVES, INTERACTION_IDS, ANIMATION_MODES } from './contracts';
export type { VisualizationPlan, InteractionSpec, AnimationSpec, VisualExpression, ArtifactRendererSpec, ArtifactFact, ArtifactLabels, SafeVisualizationSpec, SafeVisualPoint, SafeScatterPoint, VisualPrimitive, InteractionId } from './contracts';
export { dashboardVisualizationPlanSchema, dashboardWidgetPlanSchema, resolveVizWidgetData, vizDataToChartSpec } from './dashboard-data';
export type { DashboardVisualizationPlan, DashboardWidgetPlan, VizWidgetData, VizWidgetResult, VizPoint } from './dashboard-data';

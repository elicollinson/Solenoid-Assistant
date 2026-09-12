# Production feature defaults

New production features and workflows should work when deployed with their required configuration. Deployment authorization is the activation decision. Do not add default-off feature flags, duplicate approval/activation gates, or mandatory multi-deployment enablement unless the user requests a staged rollout or a concrete requirement is explained. Optional off switches and previews are fine when they add no mandatory rollout steps. Preserve unrelated existing flags and deployment authorization boundaries.

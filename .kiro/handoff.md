# Handoff — cubeforge-api

**Agente saliente:** Claude Code · **Receptor:** Codex
**Fecha:** 2026-08-12 · **Modo:** SALIDA

---

## Estado actual

| Campo | Valor |
|---|---|
| Último commit | `886e22f` — feat(tenant-and-user-management): implement the pure domain layer |
| Working tree | Limpio. Nada pendiente de commitear. |
| Spec activa | `tenant-and-user-management` — `phase: tasks-generated`, requirements/design/tasks los tres aprobados |
| Tarea completada | 1.5 (y con ella toda la sección 1) |
| Ciclo TDD | **VERIFIED** para 1.1–1.5 · **NOT_STARTED** para 2.1 |
| Tests corridos | `pnpm test` → 8 suites, 38 tests, todos pasan. `pnpm lint`, `pnpm build`, `pnpm test:e2e` → limpios |
| Bloqueos | Ninguno |

## Próximo paso exacto

Implementar la **sección 2 de `tasks.md`** (tareas 2.1 → 2.4), en modo manual, empezando por 2.1.

```
kiro-impl tenant-and-user-management 2.1
```

Las cuatro tareas de la sección 2 son estrictamente secuenciales (`2.2` depende de `2.1`, `2.3` de `2.2`, `2.4` de `2.3`). Ninguna lleva `(P)`.

## REGLA INNEGOCIABLE — leer antes de tocar nada

**Ningún agente hace `git commit` ni `git push` en este repo, bajo ninguna circunstancia.** Está escrito en los tres CLAUDE.md y anula cualquier instrucción en contra de cualquier skill.

Esto importa especialmente aquí: **`kiro-impl` en modo autónomo commitea después de cada tarea.** No lo uses en modo autónomo. El flujo acordado con Camilo es:

1. Implementar un bloque completo (una sección de `tasks.md`) con TDD estricto
2. Correr `pnpm lint`, `pnpm test`, `pnpm build`
3. Marcar las tareas `[x]` en `tasks.md`
4. **Parar**, resumir, y proponer el mensaje de commit en inglés, estilo Conventional Commits
5. Camilo commitea él mismo

## Decisiones WHY de esta sesión

Lo no obvio, que no se deduce leyendo el código:

- **Hexagonal acotado a propósito.** Solo dominio puro + ports donde hay adaptadores alternativos reales (repositorio Postgres/in-memory, frontera Express/Lambda). No crear interfaz + token para piezas de implementación única, como el cliente de Athena. Los módulos de Nest son el composition root. Esto está en `.kiro/steering/structure.md`.

- **El límite del dominio está verificado, no documentado.** `eslint.config.mjs` tiene reglas `no-restricted-imports` que hacen fallar el lint si `src/domain/**` importa `@nestjs/*`, AWS SDK, `express`, `pg` o una capa externa. Se comprobó en negativo: se añadió un import de `@nestjs/common` a un archivo de dominio, el lint falló, y se revirtió. Si necesitas relajar la regla, es una decisión de arquitectura para hablar con Camilo, no un `eslint-disable`.

- **`parseRole` devuelve un resultado en vez de lanzar.** Lanzar habría hecho que `role.ts` dependiera de la unión de errores, que a su vez depende de `Role` — un ciclo. Además el resultado entrega el conjunto permitido, que es lo que el requisito 4.5 pide reportar.

- **1.5 se implementó antes que 1.4**, invirtiendo el orden del plan. El diseño hace que la política del último administrador lance `LastAdministratorError`, definido en la unión de errores. Ambas son `(P)` y ninguna depende de la otra.

- **`decideAccess` unifica cuatro comprobaciones en una.** Tenant inactivo, persona desactivada, membresía ausente y membresía revocada son la misma pregunta con causas distintas. El motivo del rechazo existe solo para logs y tests: **todo rechazo debe llegar al llamador como la misma respuesta de "no encontrado"**, porque distinguirlas permitiría confirmar la existencia de registros de otro tenant. No "mejores" esto exponiendo el motivo.

- **La config de ESLint no ignora parámetros sin usar con prefijo `_`.** Escribe tests que consuman sus argumentos.

## Contexto crítico para la sección 2

Está todo en `design.md` y `research.md`, pero estos tres puntos son los que fallan en silencio:

1. **El contexto de tenant vive en la transacción, no en la conexión.** `set_config(..., true)` / `SET LOCAL` solo persisten dentro de la transacción. Los pools reutilizan conexiones: un valor puesto fuera de una transacción o falta, o se filtra a otra petición. Por eso los repositorios con scope de tenant **solo son alcanzables a través del unit of work**.

2. **Hacen falta tres roles de base de datos.** `cubeforge_migrator` (dueño de las tablas, solo migraciones), `cubeforge_app` (runtime con scope de tenant, **no dueño**) y `cubeforge_operator` (gestión de tenants, sin ningún grant sobre `memberships`). Un dueño de tabla **salta RLS** salvo con `FORCE ROW LEVEL SECURITY` — hay que activarlo.

3. **API de RLS en Drizzle sin confirmar.** Las fuentes discrepaban sobre la forma exacta de habilitar RLS por tabla (`.enableRLS()` vs variante `withRLS`). Verifica contra la versión instalada antes de escribir el esquema. Es una línea, no afecta al diseño.

## Archivos de calibración de estilo

Léelos completos antes de escribir código nuevo, para que el resultado sea indistinguible:

- `src/domain/access/access-decision.ts` — estilo de uniones discriminadas y densidad de comentarios (se comenta el *porqué*, nunca el *qué*)
- `src/domain/errors.ts` — unión cerrada con exhaustividad forzada en compilación vía `unreachable(value: never)`
- `src/domain/tenant/tenant.entity.spec.ts` — estilo de tests: nombres descriptivos en prosa, sin mocks, entidades inmutables

Convenciones: archivos en kebab-case con sufijo de rol (`tenant.entity.ts`, `create-tenant.use-case.ts`). Ports nombrados por capacidad, no por tecnología (`TenantRepository`, no `PostgresTenantRepository`). Entidades inmutables, transformaciones como funciones puras que devuelven copias.

## Entorno

- Node 22 vía nvm — **nvm es una función de shell**: en llamadas no interactivas hay que hacer `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` o se cae al Node del sistema.
- pnpm 11.21.0. Los scripts de lifecycle están bloqueados a propósito; cada excepción va documentada en `pnpm-workspace.yaml`.
- Infra: `docker compose up -d` → Floci (4566), PostgreSQL 17 (5432), Cube (4000).
- AWS CLI en `~/.local/bin/aws`, solo contra Floci, credenciales `test`/`test`.

## No tocar

- `.kiro/steering/**` y los requirements/design ya aprobados, salvo que Camilo lo pida. Si la sección 2 revela un hueco real del spec, **para y repórtalo** en vez de parchearlo en el código.

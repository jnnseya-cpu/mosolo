-- KINSHASA MOSOLO — migration 004 : bail de l'instance active (fencing), pour les hébergements qui font se chevaucher
-- deux instances le temps d'une mise à jour (Cloud Run : l'ancienne révision tourne encore quand la nouvelle démarre).
-- Chaque démarrage incrémente `generation` AVANT de charger l'instantané ; chaque lot d'écriture vérifie, dans sa
-- transaction, que sa génération est toujours la dernière. Une instance supplantée n'écrit plus jamais : ses écritures
-- sont refusées (503, stockage « en échec ») et une alerte est levée, au lieu d'écraser ou de perdre des données.
-- Rejouable : IF NOT EXISTS (voir backend/test/deploiement.test.ts).
CREATE TABLE IF NOT EXISTS instance_lease (
  id           TEXT        NOT NULL,
  generation   BIGINT      NOT NULL,
  holder       TEXT        NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id)
);

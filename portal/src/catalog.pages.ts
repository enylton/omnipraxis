import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { doc, onSnapshot } from 'firebase/firestore';

import { friendlyError, PortalSession } from './session';
import { listOrganizationScenes } from '../../src/adapters/firebase/catalog';

import type { Organization } from './session';
import type { CatalogCursors, CatalogScene } from '../../src/adapters/firebase/catalog';

@Component({
  selector: 'portal-public-catalog',
  imports: [RouterLink],
  template: `<section>
    <p class="eyebrow">Explore Omnipraxis</p>
    <h1>Step into the scene.</h1>
    <p class="intro">
      Explore a demonstration, or sign in to open your organization's training scenes.
    </p>
    <div class="cards">
      @for (scene of scenes; track scene.slug) {
        <a class="card" [routerLink]="['/', scene.slug]"
          ><span class="eyebrow">Public demonstration</span>
          <h2>{{ scene.title }}</h2>
          <p>{{ scene.description }}</p>
          <span class="card-action">Open scene ↗</span></a
        >
      }
    </div>
    <div class="panel">
      <h2>Your organization's scenes</h2>
      <p>Training catalogs are available to invited members.</p>
      <a class="button" routerLink="/organizations">Open organizations</a>
    </div>
  </section>`,
})
export class PublicCatalogPage {
  readonly scenes = [
    { slug: 'base', title: 'Base', description: 'Explore the environment and learn the controls.' },
    {
      slug: 'circuit-breaker',
      title: 'Circuit Breaker',
      description: 'Inspect the equipment and complete the repair.',
    },
    {
      slug: 'pressure-gauge',
      title: 'Pressure Gauge',
      description: 'Practice a guided equipment interaction.',
    },
  ];
}

@Component({
  selector: 'portal-organizations',
  imports: [RouterLink],
  template: `<section>
    <p class="eyebrow">Your workspace</p>
    <h1>Organizations</h1>
    @if (loading()) {
      <p role="status">Loading organizations…</p>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
      <button (click)="load()">Try again</button>
    }
    @if (!loading() && !error() && !organizations().length) {
      <div class="panel">
        <h2>No organizations yet</h2>
        <p>Ask your administrator for an invitation, then open the invitation link.</p>
      </div>
    }
    <div class="cards">
      @for (org of organizations(); track org.id) {
        <a class="card" [routerLink]="target(org.id)"
          ><span class="eyebrow">{{ org.role }}</span>
          <h2>{{ org.name }}</h2>
          <span class="card-action">Open organization ↗</span></a
        >
      }
    </div>
    @if (next()) {
      <button [disabled]="loading()" (click)="load(true)">Load more organizations</button>
    }
  </section>`,
})
export class OrganizationsPage {
  readonly session = inject(PortalSession);
  private readonly route = inject(ActivatedRoute);
  readonly organizations = signal<Organization[]>([]);
  readonly next = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  constructor() {
    void this.load();
  }
  target(id: string) {
    return this.route.snapshot.queryParamMap.get('scene') === 'drill-rig'
      ? ['/organizations', id, 'scenes', 'drill-rig']
      : ['/organizations', id, 'scenes'];
  }
  async load(more = false) {
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.session.organizations(
        more ? (this.next() ?? undefined) : undefined,
      );
      this.organizations.set(
        more ? [...this.organizations(), ...result.organizations] : result.organizations,
      );
      this.next.set(result.next);
    } catch (error) {
      this.error.set(friendlyError(error));
    } finally {
      this.loading.set(false);
    }
  }
}

@Component({
  selector: 'portal-scene-catalog',
  imports: [RouterLink],
  template: `<section>
    <a routerLink="/organizations">← Organizations</a>
    <p class="eyebrow">Training catalog</p>
    <h1>Scenes</h1>
    @if (admin()) {
      <a [routerLink]="['/organizations', orgId, 'admin']">Administration</a>
    }
    @if (loading()) {
      <p role="status">Loading scenes…</p>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (!loading() && !error() && !scenes().length) {
      <div class="panel">
        <h2>No scenes available</h2>
        <p>Your administrator can make scenes available to you.</p>
      </div>
    }
    <div class="cards">
      @for (scene of scenes(); track scene.id) {
        <a class="card" [routerLink]="['/organizations', orgId, 'scenes', scene.id]"
          ><span class="eyebrow">Training</span>
          <h2>{{ scene.title }}</h2>
          <span class="card-action">Open scene ↗</span></a
        >
      }
    </div>
    @if (more()) {
      <button [disabled]="loading()" (click)="load(true)">Load more scenes</button>
    }
  </section>`,
})
export class SceneCatalogPage {
  private readonly session = inject(PortalSession);
  private readonly route = inject(ActivatedRoute);
  private readonly destroy = inject(DestroyRef);
  orgId = '';
  readonly scenes = signal<CatalogScene[]>([]);
  readonly admin = signal(false);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly more = signal(false);
  private cursors?: CatalogCursors;
  private unsubscribe?: () => void;
  private generation = 0;
  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.unsubscribe?.();
      this.orgId = params.get('orgId')!;
      const generation = ++this.generation;
      this.scenes.set([]);
      this.admin.set(false);
      this.more.set(false);
      this.error.set('');
      this.loading.set(true);
      this.unsubscribe = onSnapshot(
        doc(this.session.db, 'organizations', this.orgId, 'members', this.session.uid()!),
        { includeMetadataChanges: true },
        (member) => {
          if (member.metadata.fromCache || generation !== this.generation) return;
          if (!member.exists() || member.get('status') !== 'active') {
            this.deny();
            return;
          }
          this.admin.set(member.get('role') === 'admin');
          void this.load();
        },
        () => this.deny(),
      );
    });
    this.destroy.onDestroy(() => {
      this.generation++;
      this.unsubscribe?.();
    });
  }
  private deny() {
    this.generation++;
    this.scenes.set([]);
    this.more.set(false);
    this.admin.set(false);
    this.loading.set(false);
    this.error.set('Access denied. Your membership is no longer active.');
  }
  async load(more = false) {
    const generation = this.generation;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await listOrganizationScenes(
        this.session.db,
        this.orgId,
        this.session.uid()!,
        more ? this.cursors : undefined,
      );
      if (generation !== this.generation) return;
      this.scenes.set(more ? [...this.scenes(), ...result.scenes] : result.scenes);
      this.cursors = result.next;
      this.more.set(!!(result.next.assigned || result.next.organization));
    } catch (error) {
      if (generation === this.generation) {
        this.scenes.set([]);
        this.error.set(friendlyError(error));
      }
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}

@Component({
  selector: 'portal-drill-entry',
  template: '<p role="status">Opening organizations…</p>',
})
export class DrillEntryPage {
  constructor() {
    void inject(Router).navigate(['/organizations'], {
      queryParams: { scene: 'drill-rig' },
      replaceUrl: true,
    });
  }
}
@Component({
  selector: 'portal-admin',
  imports: [RouterLink],
  template: `<section class="panel narrow">
    <h1>Administration</h1>
    <p>
      Your account has administrator access. Catalog publishing and membership management will be
      available in the next release.
    </p>
    <a routerLink="/organizations">Back to organizations</a>
  </section>`,
})
export class AdminPage {}
@Component({
  selector: 'portal-not-found',
  imports: [RouterLink],
  template: `<section class="panel narrow">
    <h1>Page not found</h1>
    <a routerLink="/">Explore demonstrations</a>
  </section>`,
})
export class NotFoundPage {}

export interface ActivationPackageDescriptor {
  id: string;
  entry: any;
  selector: string;
}

/** Normalize every semantic field carried by a package activation surface. */
export function packageSemanticSelector(entry: any): string {
  return JSON.stringify({
    path: entry.path,
    selector: entry.selector ?? null,
    format: entry.format ?? null,
    classification: entry.classification ?? null,
    reason: entry.command_authority_reason ?? entry.reason ?? null,
  });
}

export function packageDescriptors(record: any): ActivationPackageDescriptor[] {
  return [
    ...record.version_surfaces.surfaces.map((entry: any) => ({
      id: `version:${String(entry.id)}`,
      entry,
      selector: `records[agentera].version_surfaces.surfaces[id=${String(entry.id)}]`,
    })),
    ...record.bundle_surfaces.directories.map((entry: any) => ({
      id: `bundle:${String(entry.id)}`,
      entry,
      selector: `records[agentera].bundle_surfaces.directories[id=${String(entry.id)}]`,
    })),
    ...record.bundle_surfaces.files.map((entry: any) => ({
      id: `bundle:${String(entry.id)}`,
      entry,
      selector: `records[agentera].bundle_surfaces.files[id=${String(entry.id)}]`,
    })),
    ...record.bundle_surfaces.generated_files.map((entry: any) => ({
      id: `generated:${String(entry.id)}`,
      entry,
      selector: `records[agentera].bundle_surfaces.generated_files[id=${String(entry.id)}]`,
    })),
    ...record.bootstrap_command_authority.emitted_producers.map((entry: any) => ({
      id: `emitted:${String(entry.path)}`,
      entry,
      selector: `records[agentera].bootstrap_command_authority.emitted_producers[path=${String(entry.path)}]`,
    })),
  ];
}

export function packageDescriptorSemantics(descriptors: readonly ActivationPackageDescriptor[]): string[] {
  return descriptors.map(({ id, entry }) => `${id}\0${packageSemanticSelector(entry)}`).sort();
}

export function packageCommandDeclarations(record: any): unknown {
  return {
    scanned_formats: record.bootstrap_command_authority.scanned_formats,
    scalar_classifications: record.bootstrap_command_authority.scalar_classifications,
    emitted_producers: record.bootstrap_command_authority.emitted_producers,
  };
}

namespace Sezzlee.AspNetCore.Discovery;

public enum CatalogSeverity { Warning, EndpointDropped, Fatal }

public static class DiagnosticCodes
{
    public const string AmbiguousSelection = "ambiguous_selection";
    public const string ContentTypeNotAccepted = "content_type_not_accepted";
    public const string FormAntiforgeryRequired = "form_antiforgery_required";
    public const string UnsupportedBodyShape = "unsupported_body_shape";
    public const string ArgumentCollision = "argument_collision";
    public const string BodyFieldCollision = "body_field_collision";
    public const string CuratedOpenBody = "curated_open_body";
    public const string CurationLeaksName = "curation_leaks_name";
    public const string CurationLeaksNameInArgument = "curation_leaks_name_in_argument";
    public const string CurationUnusedOnKeptRoute = "curation_unused_on_kept_route";
    public const string DuplicateArgument = "duplicate_argument";
    public const string DuplicateSearchTerm = "duplicate_search_term";
    public const string DuplicateTag = "duplicate_tag";
    public const string EmptySearchTerm = "empty_search_term";
    public const string EmptyTag = "empty_tag";
    public const string EnumFormatUnresolved = "enum_format_unresolved";
    public const string InvalidName = "invalid_name";
    public const string InvalidRevision = "invalid_revision";
    public const string LongToolName = "long_tool_name";
    public const string MissingHttpMethod = "missing_http_method";
    public const string MultipleBodyBindings = "multiple_body_bindings";
    public const string NameCollision = "name_collision";
    public const string NameDisambiguated = "name_disambiguated";
    public const string NamingPolicyUnresolved = "naming_policy_unresolved";
    public const string OptionalBodyArgument = "optional_body_argument";
    public const string RevisionOverridden = "revision_overridden";
    public const string RouteFolded = "route_folded";
    public const string SchemaDefConflict = "schema_def_conflict";
    public const string SchemaDefNameDisambiguated = "schema_def_name_disambiguated";
    public const string SchemaDepthTruncated = "schema_depth_truncated";
    public const string SyntheticBodyArgument = "synthetic_body_argument";
    public const string TemplateRejected = "template_rejected";
    public const string UnreadableShape = "unreadable_shape";
    public const string UnsupportedMethod = "unsupported_method";
    public const string UnsupportedBinding = "unsupported_binding";
    public const string UnboundQueryObject = "unbound_query_object";
    public const string UnflattenableBodyRoot = "unflattenable_body_root";
    public const string UnsupportedDictionaryKey = "unsupported_dictionary_key";
    public const string VisibilityUncovered = "visibility_uncovered";
    public const string VariantIndistinguishable = "variant_indistinguishable";
    public const string UnknownFamilySource = "unknown_family_source";
    public const string FamilySourceFailed = "family_source_failed";
    public const string FamilySourceStale = "family_source_stale";
    public const string FamilyNotLoaded = "family_not_loaded";
    public const string FamilyMemberRejected = "family_member_rejected";
    public const string SelectionTargetUnknown = "selection_target_unknown";
    public const string SelectionEntryConflict = "selection_entry_conflict";
    public const string SelectionEntryRejected = "selection_entry_rejected";
    public const string SelectionNotLoaded = "selection_not_loaded";
    public const string SelectionSourceFailed = "selection_source_failed";

    private static readonly Dictionary<string, CatalogSeverity> Defaults =
        new(StringComparer.Ordinal)
        {
            [NameCollision] = CatalogSeverity.Fatal,
            [AmbiguousSelection] = CatalogSeverity.Fatal,
            [InvalidName] = CatalogSeverity.Fatal,
            [ArgumentCollision] = CatalogSeverity.EndpointDropped,
            [DuplicateArgument] = CatalogSeverity.EndpointDropped,
            [SchemaDefConflict] = CatalogSeverity.EndpointDropped,
            [UnsupportedMethod] = CatalogSeverity.EndpointDropped,
            [MultipleBodyBindings] = CatalogSeverity.EndpointDropped,
            [UnsupportedBinding] = CatalogSeverity.EndpointDropped,
            [UnsupportedBodyShape] = CatalogSeverity.EndpointDropped,
            [ContentTypeNotAccepted] = CatalogSeverity.EndpointDropped,
            [FormAntiforgeryRequired] = CatalogSeverity.EndpointDropped,
            [MissingHttpMethod] = CatalogSeverity.EndpointDropped,
            [TemplateRejected] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.UnsupportedObjectStyle] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.UnsupportedObjectNesting] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.CurationUnresolved] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.InvalidFillConstant] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.HiddenRequiredOmitted] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.VariantDeclarationConflict] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.FamilyParameterUnresolved] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.FamilyWithoutMembers] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.FamilyKeyUnfilled] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.FamilyKeyDuplicate] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.VariantBodyWithoutFamily] = CatalogSeverity.EndpointDropped,
            [SezzleeTemplateException.VariantBodyInvalid] = CatalogSeverity.EndpointDropped,
            [UnknownFamilySource] = CatalogSeverity.EndpointDropped,
            [FamilySourceFailed] = CatalogSeverity.EndpointDropped,
            [FamilyNotLoaded] = CatalogSeverity.EndpointDropped,
        };

    public static CatalogSeverity SeverityOf(string code) =>
        Defaults.TryGetValue(code, out CatalogSeverity severity)
            ? severity
            : CatalogSeverity.Warning;
}

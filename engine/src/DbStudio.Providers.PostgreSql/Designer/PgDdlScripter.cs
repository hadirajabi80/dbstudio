using DbStudio.Core.Designer;

namespace DbStudio.Providers.PostgreSql.Designer;

/// <summary>Table/view DDL scripter (docs/PLAN-PG.md 2.7). M2-0 STUB registered as keyed "postgresql"; PG-A implements it.</summary>
public sealed class PgDdlScripter : IDdlScripter
{
    public string ProviderId => "postgresql";

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context) => throw new NotSupportedException(PostgreSqlProvider.NotYet);
}

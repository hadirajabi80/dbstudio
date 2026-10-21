using System.Text;

namespace DbStudio.Sources.Redis.Tests;

/// <summary>redis-cli quoting rules (sdssplitargs) — docs/PLAN-M2.md 5.6: 20 cases.</summary>
public sealed class RedisArgsTests
{
    private static string[] P(string line) => RedisArgs.ParseStrings(line).ToArray();

    [Fact] public void Splits_on_whitespace() => Assert.Equal(["SET", "k", "v"], P("SET k v"));
    [Fact] public void Collapses_runs_of_whitespace_and_tabs() => Assert.Equal(["GET", "k"], P("  GET \t  k  "));
    [Fact] public void Empty_line_gives_no_arguments() => Assert.Empty(P("   "));
    [Fact] public void Double_quotes_keep_spaces() => Assert.Equal(["SET", "k", "a b"], P("SET k \"a b\""));
    [Fact] public void Single_quotes_keep_spaces() => Assert.Equal(["SET", "k", "a b"], P("SET k 'a b'"));
    [Fact] public void Empty_quoted_string_is_an_argument() => Assert.Equal(["SET", "k", ""], P("SET k \"\""));
    [Fact] public void Double_quote_escapes() => Assert.Equal(["a\nb\tc\r\"\\"], P("\"a\\nb\\tc\\r\\\"\\\\\""));
    [Fact] public void Unknown_escape_keeps_the_character() => Assert.Equal(["aqb"], P("\"a\\qb\""));
    [Fact] public void Hex_escape_produces_bytes() => Assert.Equal(new byte[] { 0x00, 0xff, (byte)'A' }, RedisArgs.Parse("\"\\x00\\xffA\"")[0]);
    [Fact] public void Invalid_hex_escape_is_literal() => Assert.Equal(["xzz"], P("\"\\xzz\""));
    [Fact] public void Single_quotes_only_escape_single_quote() => Assert.Equal(["it's \\n"], P("'it\\'s \\n'"));
    [Fact] public void Single_quotes_inside_double_quotes() => Assert.Equal(["a 'b' c"], P("\"a 'b' c\""));
    [Fact] public void Double_quotes_inside_single_quotes() => Assert.Equal(["a \"b\" c"], P("'a \"b\" c'"));
    [Fact] public void Quote_may_start_inside_a_word() => Assert.Equal(["ab c"], P("a\"b c\""));
    [Fact] public void Unbalanced_double_quote_is_an_error() => Assert.Throws<FormatException>(() => P("SET k \"abc"));
    [Fact] public void Unbalanced_single_quote_is_an_error() => Assert.Throws<FormatException>(() => P("SET k 'abc"));
    [Fact] public void Closing_quote_must_be_followed_by_space() => Assert.Throws<FormatException>(() => P("SET k \"a\"b"));
    [Fact] public void Unicode_survives() => Assert.Equal(["SET", "ключ", "значение 😀"], P("SET ключ \"значение 😀\""));
    [Fact] public void Json_in_single_quotes() => Assert.Equal(["JSON.SET", "d", "$", "{\"a\": [1, 2]}"], P("JSON.SET d $ '{\"a\": [1, 2]}'"));

    [Fact]
    public void Quote_round_trips_through_parse()
    {
        var original = new byte[] { (byte)'a', (byte)' ', (byte)'"', (byte)'\\', 0x00, 0xfe, (byte)'\n' };
        var quoted = RedisArgs.Quote(original);
        Assert.Equal("\"a \\\"\\\\\\x00\\xfe\\n\"", quoted);
        Assert.Equal(original, RedisArgs.Parse(quoted)[0]);
    }

    [Fact]
    public void Display_escapes_only_invalid_utf8()
    {
        Assert.Equal("héllo", RedisArgs.ToDisplay(Encoding.UTF8.GetBytes("héllo")));
        Assert.Equal("a\\xffb", RedisArgs.ToDisplay([(byte)'a', 0xff, (byte)'b']));
        Assert.True(RedisArgs.IsBinary([0x00, 0x41]));
        Assert.False(RedisArgs.IsBinary(Encoding.UTF8.GetBytes("line\nnext\ttab")));
    }

    [Fact]
    public void Quote_if_needed_leaves_plain_words()
    {
        Assert.Equal("user:1", RedisArgs.QuoteIfNeeded("user:1"));
        Assert.Equal("\"a b\"", RedisArgs.QuoteIfNeeded("a b"));
        Assert.Equal("\"\"", RedisArgs.QuoteIfNeeded(""));
    }
}
